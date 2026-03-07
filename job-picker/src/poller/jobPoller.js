/**
 * Job Poller — High-speed 3-phase pipeline for picking Amazon shifts.
 * Phase 1: createApplication (POST) → get applicationId
 * Phase 2: WebSocket connect → completeTask + startWorkflow
 * Phase 3: updateApplication (PUT) tight loop → job-confirm
 *
 * Each poller handles one jobId+scheduleId combination.
 * Uses unique candidateId + token + IP per session.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const log = require('../utils/logger');

const ROTATE_BOTH = 'ROTATE_BOTH';
const ROTATE_IP = 'ROTATE_IP_ONLY';

class JobPoller {
  constructor({ jobId, scheduleId, sessionManager, proxyManager, settings, onJobPicked }) {
    this.jobId = jobId;
    this.scheduleId = scheduleId;
    this.sessionManager = sessionManager;
    this.proxyManager = proxyManager;
    this.settings = settings;
    this.onJobPicked = onJobPicked; // Callback for Telegram etc.

    this.isRunning = false;
    this.stopped = false;
    this.applicationId = null;
    this.socket = null;
    this.currentCandidate = null;
    this.forceIpRotation = false;
    this.startTime = 0;
    this.timerLimit = this._jitteredTimer();
    this.requestCount = 0;
    this.lastIP = 'unknown';

    // Determine country from jobId
    this.isUS = jobId.includes('JOB-US-');
    this.domain = this.isUS ? 'hiring.amazon.com' : 'hiring.amazon.ca';
    this.locale = this.isUS ? 'en-US' : 'en-CA';
    this.cc = this.isUS ? 'US' : 'CA';

    this.tag = `Poller:${jobId.slice(-4)}-${scheduleId.slice(-4)}`;

    this.baseHeaders = {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'bb-ui-version': 'bb-ui-v2',
      'cache-control': 'no-cache',
      'content-type': 'application/json;charset=UTF-8',
      'pragma': 'no-cache',
      'priority': 'u=1, i',
      'sec-ch-ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
      'sec-ch-ua-mobile': '?1',
      'sec-ch-ua-platform': '"Android"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Connection': 'keep-alive',
    };
  }

  _jitteredTimer() {
    const base = this.settings.ip_rotation_interval_ms || 120000;
    const jitter = this.settings.ip_rotation_jitter_ms || 15000;
    return base + (Math.random() * 2 * jitter - jitter);
  }

  _checkTimer() {
    if (Date.now() - this.startTime > this.timerLimit) {
      const err = new Error('IP rotation timer');
      err.code = ROTATE_IP;
      throw err;
    }
  }

  _resetTimer() {
    this.startTime = Date.now();
    this.timerLimit = this._jitteredTimer();
  }

  _resetAppState() {
    try {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.close();
      }
    } catch (e) {}
    this.socket = null;
    this.applicationId = null;
  }

  /**
   * Make an HTTPS request through the proxy with timeout.
   */
  _request(method, path, body, candidateId) {
    return new Promise((resolve, reject) => {
      const session = this.sessionManager.get(candidateId);
      if (!session) {
        return reject(new Error('No session for ' + candidateId));
      }

      const stickyData = this.proxyManager.getStickyAgent(candidateId);
      if (!stickyData) {
        return reject(new Error('No proxy available'));
      }

      // Handle force IP rotation
      if (this.forceIpRotation) {
        this.proxyManager.release(candidateId);
        const newData = this.proxyManager.getStickyAgent(candidateId);
        if (newData) {
          stickyData.agent = newData.agent;
          stickyData.proxyUrl = newData.proxyUrl;
        }
        this.forceIpRotation = false;
      }

      this.lastIP = stickyData.proxyUrl;

      const url = `https://${this.domain}${path}`;
      const urlObj = new URL(url);

      // Build headers
      const headers = { ...this.baseHeaders };
      const ref = `https://${this.domain}/application/${this.cc.toLowerCase()}/?CS=true&jobId=${this.jobId}&locale=${this.locale}&scheduleId=${this.scheduleId}&ssoEnabled=1`;
      headers['referer'] = ref;

      // Inject auth from session
      if (session.accessToken) headers['Authorization'] = session.accessToken;

      // Serialize cookies
      if (session.cookies && session.cookies.length > 0) {
        headers['Cookie'] = session.cookies
          .filter(c => {
            const cd = c.domain.replace(/^\./, '');
            return this.domain.endsWith(cd);
          })
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
      }

      let bodyStr;
      if (body) {
        bodyStr = JSON.stringify(body);
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
        agent: stickyData.agent,
      };

      const timeout = this.settings.upstream_timeout_ms || 2500;

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data,
            ip: stickyData.proxyUrl,
          });
        });
      });

      req.setTimeout(timeout, () => {
        req.destroy(new Error('TIMEOUT'));
      });

      req.on('socket', (socket) => {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 60000);
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  /**
   * Handle rate limit response — pause candidate, release IP, throw ROTATE_BOTH.
   */
  _handleRateLimit(candidateId, status) {
    log.warn(this.tag, `Rate limited (${status}) for ${candidateId} via ${this.lastIP}`);
    this.sessionManager.pause(candidateId, this.settings.pause_on_429_ms || 30000);
    this.proxyManager.release(candidateId);
    const err = new Error('Rate limited');
    err.code = ROTATE_BOTH;
    throw err;
  }

  // ===== PHASE 1: Create Application =====
  async phase1(candidateId) {
    const path = '/application/api/candidate-application/ds/create-application/';
    const body = {
      jobId: this.jobId,
      dspEnabled: true,
      scheduleId: this.scheduleId,
      candidateId,
      candidate_id: candidateId,
      activeApplicationCheckEnabled: true,
    };

    while (!this.stopped) {
      this._checkTimer();

      try {
        const res = await this._request('POST', path, body, candidateId);

        // Rate limit check
        if (res.status === 429 || res.status === 403) {
          this._handleRateLimit(candidateId, res.status);
        }

        // Timeout/server error — retry immediately
        if (res.status === 504 || res.status === 502 || !res.body) {
          continue;
        }

        // Session expired
        if (res.status === 401 || res.status === 419) {
          this.sessionManager.remove(candidateId);
          const err = new Error('Session expired');
          err.code = ROTATE_BOTH;
          throw err;
        }

        let data;
        try { data = JSON.parse(res.body); } catch (e) { continue; }

        // Check for rate limit in body
        if (data.message === 'Too many requests, please try again later') {
          this._handleRateLimit(candidateId, '429-body');
        }

        // Success
        if (data.data && data.data.applicationId) {
          log.info(this.tag, `App created: ${data.data.applicationId} (${candidateId})`);
          return data.data.applicationId;
        }

        // App already exists
        if (data.errorCode === 'APPLICATION_ALREADY_EXIST_CAN_BE_RESET' && data.errorMetadata) {
          log.info(this.tag, `App exists: ${data.errorMetadata.applicationId} (${candidateId})`);
          return data.errorMetadata.applicationId;
        }

        // Other error — retry
        await new Promise(r => setTimeout(r, 20));
      } catch (err) {
        if (err.code === ROTATE_BOTH || err.code === ROTATE_IP) throw err;
        if (err.message === 'TIMEOUT') continue;
        await new Promise(r => setTimeout(r, 20));
      }
    }
    throw new Error('stopped');
  }

  // ===== PHASE 2: WebSocket =====
  async phase2(applicationId, candidateId) {
    const session = this.sessionManager.get(candidateId);
    if (!session) throw new Error('No session');

    const token = encodeURIComponent(session.accessToken);
    const wsUrl = `wss://ufatez9oyf.execute-api.us-east-1.amazonaws.com/prod?applicationId=${applicationId}&candidateId=${candidateId}&authToken=${token}`;

    // Prepare messages
    this.completeTaskMsg = {
      action: 'completeTask',
      applicationId,
      candidateId,
      requisitionId: '',
      jobId: this.jobId,
      state: 'MN',
      employmentType: 'Regular',
      eventSource: 'HVH-CA-UI',
      jobSelectedOn: new Date().toISOString(),
      currentWorkflowStep: 'job-opportunities',
      workflowStepName: '',
      partitionAttributes: { countryCodes: [this.cc] },
      filteringSeasonal: false,
      filteringRegular: false,
    };

    this.startWorkflowMsg = {
      action: 'startWorkflow',
      applicationId,
      candidateId,
      jobId: this.jobId,
      scheduleId: this.scheduleId,
      partitionAttributes: { countryCodes: [this.cc] },
      filteringSeasonal: false,
      filteringRegular: false,
    };

    // Connect WebSocket (optionally through proxy)
    const proxyUrl = this.proxyManager.getProxyUrlForCandidate(candidateId);
    const wsOptions = {};
    if (proxyUrl) {
      wsOptions.agent = new HttpsProxyAgent(proxyUrl);
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, wsOptions);
      this.socket = ws;

      const wsTimeout = setTimeout(() => {
        ws.close();
        reject(new Error('WS connect timeout'));
      }, 10000);

      ws.on('open', () => {
        clearTimeout(wsTimeout);
        log.info(this.tag, `WebSocket connected (${candidateId})`);
        resolve();
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.stepName === 'job-opportunities') {
            ws.send(JSON.stringify(this.completeTaskMsg));
          } else if (msg.stepName === 'general-questions') {
            log.success(this.tag, `Workflow progressed to general-questions!`);
          }
        } catch (e) {}
      });

      ws.on('error', (err) => {
        clearTimeout(wsTimeout);
        reject(err);
      });

      ws.on('close', () => {
        // Normal close, ignore
      });
    });
  }

  // ===== PHASE 3: Update Loop =====
  async phase3(applicationId, candidateId) {
    const path = '/application/api/candidate-application/update-application';
    const body = {
      applicationId,
      candidateId,
      candidate_id: candidateId,
      payload: { jobId: this.jobId, scheduleId: this.scheduleId },
      type: 'job-confirm',
      isCsRequest: true,
      dspEnabled: true,
    };

    log.info(this.tag, `Update loop started (${candidateId}, IP: ${this.lastIP})`);

    while (!this.stopped) {
      this._checkTimer();
      this.requestCount++;

      try {
        const res = await this._request('PUT', path, body, candidateId);

        // Rate limit
        if (res.status === 429 || res.status === 403) {
          this._handleRateLimit(candidateId, res.status);
        }

        // Timeout/server error
        if (res.status === 504 || res.status === 502 || !res.body) {
          continue;
        }

        // Session expired
        if (res.status === 401 || res.status === 419) {
          this.sessionManager.remove(candidateId);
          const err = new Error('Session expired');
          err.code = ROTATE_BOTH;
          throw err;
        }

        let data;
        try { data = JSON.parse(res.body); } catch (e) { continue; }

        // Rate limit in body
        if (data.message === 'Too many requests, please try again later') {
          this._handleRateLimit(candidateId, '429-body');
        }

        // Schedule not available — send startWorkflow and retry
        if (data.errorCode === 'SELECTED_SCHEDULE_NOT_AVAILABLE') {
          if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(this.startWorkflowMsg));
          }
          continue;
        }

        // SUCCESS — job picked!
        if (!data.errorCode) {
          const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
          log.success(this.tag, `JOB PICKED! ${this.jobId}/${this.scheduleId} by ${candidateId} in ${this.requestCount} reqs (${elapsed}s)`);

          if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(this.startWorkflowMsg));
          }

          // Trigger callback (Telegram notification etc.)
          if (this.onJobPicked) {
            this.onJobPicked({
              jobId: this.jobId,
              scheduleId: this.scheduleId,
              candidateId,
              applicationId,
              requestCount: this.requestCount,
              elapsedSeconds: parseFloat(elapsed),
              ip: this.lastIP,
            });
          }

          // Continue polling (keep trying to pick more)
          continue;
        }

        // Log every N requests
        if (this.requestCount % (this.settings.log_every_n_requests || 50) === 0) {
          log.debug(this.tag, `Req #${this.requestCount} (${candidateId}, IP: ${this.lastIP})`);
        }
      } catch (err) {
        if (err.code === ROTATE_BOTH || err.code === ROTATE_IP) throw err;
        if (err.message === 'TIMEOUT') continue;
        await new Promise(r => setTimeout(r, 50));
      }
    }
  }

  // ===== Main Loop =====
  async start() {
    this.isRunning = true;
    this.stopped = false;
    log.info(this.tag, `Starting poller: ${this.jobId} / ${this.scheduleId}`);

    while (!this.stopped) {
      try {
        // Select candidate
        if (!this.forceIpRotation) {
          const result = this.sessionManager.selectNext(this.currentCandidate);

          if (result === null) {
            log.warn(this.tag, 'No candidates available, waiting 2s...');
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }

          if (result.waitMs) {
            log.info(this.tag, `All candidates paused, waiting ${Math.ceil(result.waitMs / 1000)}s for ${result.candidateId}...`);
            await new Promise(r => setTimeout(r, result.waitMs));
            continue;
          }

          this.currentCandidate = result;
        }

        if (!this.currentCandidate) continue;

        this._resetTimer();
        this.requestCount = 0;

        // Run 3-phase pipeline
        this.applicationId = await this.phase1(this.currentCandidate);
        await this.phase2(this.applicationId, this.currentCandidate);
        await this.phase3(this.applicationId, this.currentCandidate);

      } catch (e) {
        if (e.code === ROTATE_BOTH) {
          const oldIP = this.lastIP;
          const oldId = this.currentCandidate;
          this._resetAppState();

          const newId = this.sessionManager.selectNext(this.currentCandidate);
          if (newId && !newId.waitMs) {
            this.currentCandidate = newId;
          }

          log.info(this.tag, `ROTATE_BOTH: ${oldId}/${oldIP} -> ${this.currentCandidate}`);
          this._resetTimer();
          this.forceIpRotation = false;
          continue;
        }

        if (e.code === ROTATE_IP) {
          log.info(this.tag, `ROTATE_IP: Timer hit, rotating IP for ${this.currentCandidate}`);
          this.forceIpRotation = true;
          this._resetTimer();
          continue;
        }

        // Other errors
        log.error(this.tag, `Error: ${e.message}`);
        await new Promise(r => setTimeout(r, 100));
      }
    }

    log.info(this.tag, 'Poller stopped');
  }

  stop() {
    this.stopped = true;
    this.isRunning = false;
    this._resetAppState();
    if (this.currentCandidate) {
      this.sessionManager.unlock(this.currentCandidate);
      this.currentCandidate = null;
    }
  }
}

module.exports = JobPoller;
