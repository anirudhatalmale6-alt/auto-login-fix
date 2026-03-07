let authToken = "";
let cookieHeader = "";
let currentTab = null;
let candidateId = null;

// [OPTIMIZATION] Global variable to cache the Proxy URL
// This prevents slow disk reads on every request (Fixes 1s latency)
let cachedProxyUrl = 'http://localhost:8080';

// Initialize cache immediately
chrome.storage.local.get(['proxyUrl'], (result) => {
  if (result.proxyUrl) {
    cachedProxyUrl = result.proxyUrl;
  }
});

// Initialize candidateId from storage with debugging
chrome.storage.local.get(["candidateId"], (res) => {
  console.log("🔍 Storage lookup result:", res);
  if (res && res.candidateId) {
    candidateId = res.candidateId;
    console.log("✅ CandidateId loaded from storage:", candidateId);
  } else {
    candidateId = null;
    console.log("❌ No candidateId found in storage");
  }
});

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    // Update proxy cache instantly
    if (changes.proxyUrl) {
      cachedProxyUrl = changes.proxyUrl.newValue;
    }
    if (changes.candidateId) {
      const newValue = changes.candidateId.newValue;
      const oldValue = changes.candidateId.oldValue;
      console.log("🔄 CandidateId storage changed:", { oldValue, newValue });
      candidateId = newValue;
    }
  }
});

let stopped = false;

// AWS Configuration
const INSTANCE_MANAGER_URL = 'https://ez523t5prc3psqq3stvpt5a5qm0kvhsm.lambda-url.us-east-2.on.aws';

// Proxy Configuration (Kept for compatibility, but we use cachedProxyUrl mostly)
const PROXY_URL = (() => {
  // Try to get from storage, fallback to localhost
  let url = 'http://localhost:8080';
  chrome.storage.local.get(['proxyUrl'], (result) => {
    if (result.proxyUrl) {
      url = result.proxyUrl;
    }
  });
  return url;
})();

// Candidate rotation state
let registeredCandidates = [];
let activeCandidateIndex = 0;
let currentActiveCandidateId = null;
let sseConnection = null;
let sessionUpdateListeners = [];
let isLoadingCandidates = false; // Guard against recursive calls

// [NEW] Global locking mechanism to prevent multiple pollers from grabbing the same ID
let inUseCandidates = new Set(); 

// [OPTIMIZATION] Fast access to proxy URL (Memory instead of Disk)
async function getProxyUrl() {
  return cachedProxyUrl;
}

// Load registered candidates from server
async function loadRegisteredCandidates() {
  // Prevent recursive calls
  if (isLoadingCandidates) {
    return;
  }
  
  isLoadingCandidates = true;
  try {
    const proxyUrl = await getProxyUrl();
    const response = await fetch(`${proxyUrl}/sessions`, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    
    // Handle 304 gracefully (should not happen with cache headers, but just in case)
    if (response.status === 304) {
      console.log('⚠️ Received 304 Not Modified, skipping update');
      return;
    }
    
    if (!response.ok) {
      throw new Error(`Failed to load sessions: ${response.status}`);
    }
    
    registeredCandidates = await response.json();
    console.log('📋 Loaded registered candidates:', registeredCandidates.length);
    
    isLoadingCandidates = false;
  } catch (error) {
    console.error('Failed to load registered candidates:', error);
    isLoadingCandidates = false;
  }
}

// [UPDATED] Select next active candidate (non-paused, non-expired) with FCFS Locking
async function selectNextActiveCandidate(skipReload = false, previousCandidateId = null) {
  // Release the previous candidate lock if we are swapping
  if (previousCandidateId) {
    inUseCandidates.delete(previousCandidateId);
  }

  // Only reload if not already loading and not explicitly skipped
  if (!skipReload && !isLoadingCandidates) {
    await loadRegisteredCandidates();
    skipReload = true;
  }
  
  if (registeredCandidates.length === 0) {
    currentActiveCandidateId = candidateId; // Fallback to local candidateId
    inUseCandidates.add(currentActiveCandidateId);
    return currentActiveCandidateId;
  }

  const now = Date.now();
  const activeCandidates = registeredCandidates.filter(c => {
    if (c.status === 'expired') return false;
    if (c.status === 'paused' && c.pausedUntil) {
      return c.pausedUntil <= now; 
    }
    return c.status === 'active';
  });

  // Strict FCFS: Filter out candidates that are currently locked by other pollers
  const availableCandidates = activeCandidates.filter(c => !inUseCandidates.has(c.candidateId));

  if (availableCandidates.length === 0) {
    // All are paused or in use - find the one with shortest remaining pause
    const pausedCandidates = registeredCandidates.filter(c => c.status === 'paused' && c.pausedUntil);
    if (pausedCandidates.length > 0) {
      pausedCandidates.sort((a, b) => (a.pausedUntil || 0) - (b.pausedUntil || 0));
      const waitMs = pausedCandidates[0].pausedUntil - now;
      console.log(`⏳ All candidates busy/paused, waiting ${Math.ceil((waitMs > 0 ? waitMs : 1000)/1000)}s...`);
      await delay(waitMs > 0 ? waitMs : 1000);
      return selectNextActiveCandidate(true);
    }
    // No active candidates, force share fallback
    currentActiveCandidateId = activeCandidates.length > 0 ? activeCandidates[0].candidateId : candidateId;
    inUseCandidates.add(currentActiveCandidateId);
    return currentActiveCandidateId;
  }

  // Lock the selected candidate, update the global UI reference, and return
  const selectedCandidate = availableCandidates[0].candidateId;
  inUseCandidates.add(selectedCandidate);
  currentActiveCandidateId = selectedCandidate; 
  return currentActiveCandidateId;
}

// Connect to SSE for session updates
function connectSSE() {
  getProxyUrl().then(proxyUrl => {
    if (sseConnection) {
      sseConnection.close();
    }

    const eventSource = new EventSource(`${proxyUrl}/sessions/events`);
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('📡 SSE event:', data.type);
        
        if (data.type === 'session:upsert' || data.type === 'session:expire' || 
            data.type === 'session:pause' || data.type === 'session:resume') {
          // Reload candidates when session state changes
          loadRegisteredCandidates().then(() => {
            // Notify listeners
            sessionUpdateListeners.forEach(listener => listener(registeredCandidates));
          });
        }
      } catch (err) {
        console.error('Failed to parse SSE event:', err);
      }
    };

    eventSource.onerror = (error) => {
      console.error('SSE connection error:', error);
      // Reconnect after 5 seconds
      setTimeout(() => connectSSE(), 5000);
    };

    sseConnection = eventSource;
  });
}

// Delete candidate session from server
async function deleteCandidateSession(candidateIdToDelete) {
  try {
    const proxyUrl = await getProxyUrl();
    const response = await fetch(`${proxyUrl}/sessions/${encodeURIComponent(candidateIdToDelete)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!response.ok && response.status !== 204) {
      const errorText = await response.text();
      throw new Error(`Delete failed: ${response.status} - ${errorText}`);
    }
    
    return true;
  } catch (error) {
    console.error('Delete session error:', error);
    throw error;
  }
}

// Bootstrap current session to server
async function bootstrapCurrentSession() {
  if (!candidateId || !authToken || !cookieHeader) {
    return { success: false, error: 'Missing candidateId, authToken, or cookies' };
  }

  try {
    // Get all cookies for hiring.amazon.com and hiring.amazon.ca
    const cookiesCom = await new Promise((resolve) => {
      chrome.cookies.getAll({ domain: "hiring.amazon.com" }, resolve);
    });
    const cookiesCa = await new Promise((resolve) => {
      chrome.cookies.getAll({ domain: "hiring.amazon.ca" }, resolve);
    });
    
    const allCookies = [...(cookiesCom || []), ...(cookiesCa || [])];
    
    // Convert Chrome cookie format to our format
    const cookieArray = allCookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      expires: cookie.expirationDate ? Math.floor(cookie.expirationDate) : undefined,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite === 'no_restriction' ? 'None' : 
                cookie.sameSite === 'lax' ? 'Lax' : 
                cookie.sameSite === 'strict' ? 'Strict' : 'Lax'
    }));

    const proxyUrl = await getProxyUrl();
    const response = await fetch(`${proxyUrl}/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        candidateId: candidateId,
        accessToken: authToken,
        cookies: cookieArray,
        csrf: null // Extract if available
      })
    });

    if (response.ok) {
      await loadRegisteredCandidates();
      return { success: true };
    } else {
      const error = await response.json();
      return { success: false, error: error.message || 'Bootstrap failed' };
    }
  } catch (error) {
    console.error('Bootstrap error:', error);
    return { success: false, error: error.message };
  }
}

// Initialize SSE connection on startup
setTimeout(() => {
  connectSSE();
  loadRegisteredCandidates();
}, 1000);

let predefinedJobs = [];
let awsInstances = new Map();
let successfulJobs = new Set();
let localPollers = new Map(); // Track local polling instances

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  currentTab = await chrome.tabs.get(activeInfo.tabId);
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs.length > 0) {
    currentTab = tabs[0];
  }
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .catch(error => {
      if (error.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }
      throw error;
    })
    .finally(() => clearTimeout(id));
}

async function fetchWithRetry(url, options = {}, maxRetries = 3, timeoutMs = 10000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt} failed: ${error.message}`);
      if (error.message.includes('401') || error.message.includes('403') || error.message.includes('404')) {
        throw error;
      }
      if (attempt < maxRetries) {
        await delay(attempt * 2000);
      }
    }
  }
  throw lastError;
}

// Local polling logic using your processApplication method - Enhanced for US and CA with step-based delays
class LocalPoller {
  /**
   * @param {string} jobId - The job ID.
   * @param {string} scheduleId - The schedule ID.
   * @param {number} pollingInterval - Polling interval in milliseconds (default: 0 for max speed).
   */
  constructor(jobId, scheduleId, pollingInterval = 0) { // Default to 0ms for aggressive mode
    this.jobId = jobId;
    this.scheduleId = scheduleId;
    this.isRunning = false;
    this.stopped = false;
    this.pollerId = `${jobId}-${scheduleId}-${Date.now()}`;
    
    // Application state - reset on candidate switch
    this.applicationId = null;
    this.socket = null;
    
    // [Task 4] Aggressive Mode - No Delays
    this.delays = [0]; // Force zero delays
    this.delayIndex = 0;
    this.requestCount = 0;
    
    // [Task 4] Timer state for 2 minute rotation
    this.startTime = 0;
    this.lastKnownIP = "Not set";
    
    // [NEW] Tracking variables for advanced rotation
    this.currentCandidate = null; 
    this.forceIpRotation = false; 
    this.currentTimerLimit = this.getJitteredTimer(); 

    // Determine domain and locale based on jobId
    this.isUSJob = jobId.includes('JOB-US-');
    this.domain = this.isUSJob ? 'hiring.amazon.com' : 'hiring.amazon.ca';
    this.locale = this.isUSJob ? 'en-US' : 'en-CA';
    this.countryCode = this.isUSJob ? 'US' : 'CA';
    this.countryCodes = [this.countryCode];
    
    // Fast logging with instance identification
    const instanceId = `${jobId.slice(-4)}-${scheduleId.slice(-4)}`;
    this.logPrefix = `[${instanceId}]`;
    
    this.baseHeaders = {
      'accept': "application/json, text/plain, */*",
      'accept-language': "en-US,en;q=0.9",
      'bb-ui-version': "bb-ui-v2",
      'cache-control': "no-cache",
      'content-type': "application/json;charset=UTF-8",
      'pragma': "no-cache",
      'priority': "u=1, i",
      'sec-ch-ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
      'sec-ch-ua-mobile': "?1",
      'sec-ch-ua-platform': '"Android"',
      'sec-fetch-dest': "empty",
      'sec-fetch-mode': "cors",
      'sec-fetch-site': "same-origin",
      'Referrer-Policy': "strict-origin-when-cross-origin",
      'Connection': "keep-alive" // [MAX SPEED] Force Chrome to reuse localhost socket
    };
  }

  // [NEW] Dynamically calculate a jittered timer between 105s and 135s
  getJitteredTimer() {
    return 120000 + (Math.random() * 30000 - 15000);
  }

  // Reset application state (close WS, clear applicationId)
  resetApplicationState() {
    try {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.close();
      }
    } catch (e) {
      // Ignore errors on close
    }
    this.socket = null;
    this.applicationId = null;
  }

  // Aggressive delay - returns 0
  getNextDelay() {
    return 0;
  }

  async start() {
    this.isRunning = true;
    this.stopped = false;
    console.log(`${this.logPrefix} 🚀 Starting AGGRESSIVE local poller for ${this.countryCode}`);
    console.log(`${this.logPrefix} Target: ${this.jobId}/${this.scheduleId}`);
    
    if (!authToken || !cookieHeader) {
      console.error(`${this.logPrefix} ❌ Missing auth tokens! Cannot start polling.`);
      this.stop();
      return;
    }
    
    try {
      // Set timeout for 2 hours (Global safety stop)
      setTimeout(() => {
        console.log(`${this.logPrefix} ⏰ Poller timeout after 2 hours`);
        this.stop();
      }, 2 * 60 * 60 * 1000);

      let activeCandidate = null;

      // Main loop
      while (!this.stopped && this.isRunning) {
        try {
          // Use override if we just switched, otherwise get next active
          if (!this.forceIpRotation) {
            activeCandidate = await selectNextActiveCandidate(false, this.currentCandidate);
            this.currentCandidate = activeCandidate;
          } else {
            activeCandidate = this.currentCandidate;
          }

          if (!activeCandidate) {
            console.warn(`${this.logPrefix} ⚠️ No active candidate available, waiting 1s...`);
            await delay(1000);
            continue;
          }
          
          // Reset timer only if it's a fresh start or we just rotated
          if (this.startTime === 0) {
            this.startTime = Date.now();
            this.currentTimerLimit = this.getJitteredTimer();
          }

          // Run full flow: Phase 1 → Phase 2 → Phase 3
          await this.runOnceFullFlow(activeCandidate);
          
        } catch (e) {
          if (e?.code === "ROTATE_BOTH") {
            // [LOGGING REQUIREMENT] Capture Old State
            const oldIp = this.lastKnownIP;
            const oldId = this.currentCandidate || "Unknown";

            // Reset state
            this.resetApplicationState();
            
            // [ACTION] Pick non-used ID (Rotates to next active)
            const newId = await selectNextActiveCandidate(false, this.currentCandidate);
            this.currentCandidate = newId;
            
            // [LOGGING] Print required logs
            console.log(`⚠️ ID and Ip for job ${this.jobId} and schedule ${this.scheduleId} has been changed`);
            console.log(`🔻 old - old ip ${oldIp} and candidate id ${oldId}`);
            console.log(`🔺 new - candidate id ${newId} and ip (Assigned by Proxy on next req)`);
            
            // Reset timer for the new candidate
            this.startTime = Date.now();
            this.currentTimerLimit = this.getJitteredTimer();
            this.forceIpRotation = false; 
            continue;
          } 
          else if (e?.code === "ROTATE_IP_ONLY") {
            console.log(`🔄 RULE 2: Timer limit (${(this.currentTimerLimit/1000).toFixed(1)}s) hit for ${this.jobId}. Rotating IP ONLY.`);
            this.forceIpRotation = true; 
            this.startTime = Date.now();
            this.currentTimerLimit = this.getJitteredTimer(); 
            continue;
          }
          
          // Log other errors and minimal backoff
          console.warn(`${this.logPrefix} Poller error:`, e.message || e);
          await delay(50); // Minimal backoff for network errors
        }
      }
      
    } catch (error) {
      console.error(`${this.logPrefix} ❌ Local poller error:`, error);
      this.stop();
    }
  }

  // Run full flow: Phase 1 → Phase 2 → Phase 3
  async runOnceFullFlow(activeCandidate) {
    // Phase 1: Create application
    this.applicationId = await this.phase1CreateApplication(activeCandidate);
    
    if (!this.applicationId || this.stopped) {
      throw new Error("Failed to create application or stopped");
    }

    // Phase 2: Connect WebSocket
    await this.phase2ConnectWebSocket({
      applicationId: this.applicationId,
      candidateId: activeCandidate,
      authToken: authToken
    });

    // Phase 3: Update loop
    await this.phase3UpdateLoop({
      candidate: activeCandidate,
      applicationId: this.applicationId
    });
  }

  // Phase 1: Create application
  async phase1CreateApplication(activeCandidate) {
    const ref = `https://${this.domain}/application/${this.countryCode.toLowerCase()}/?CS=true&jobId=${this.jobId}&locale=${this.locale}&scheduleId=${this.scheduleId}&ssoEnabled=1`;
    
    while (!this.stopped && this.isRunning) {
      // Check Rule 2: Jittered Timer
      if (Date.now() - this.startTime > this.currentTimerLimit) { 
          const err = new Error("Jittered timer reached");
          err.code = "ROTATE_IP_ONLY";
          throw err;
      }

      // Inject custom header if Rule 2 triggered
      const reqHeaders = { 
        ...this.baseHeaders, 
        referer: ref,
        'x-candidate-id': activeCandidate
      };
      if (this.forceIpRotation) {
        reqHeaders['x-force-ip-rotation'] = 'true';
        this.forceIpRotation = false; 
      }

      const proxyUrl = await getProxyUrl();
      
      // [NEW] 2.5 Second Client-Side Kill Switch
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);

      try {
        const createapplication = await fetch(
          `${proxyUrl}/application/api/candidate-application/ds/create-application/`,
          {
            method: "POST",
            headers: reqHeaders,
            signal: controller.signal, // Bind the abort controller
            body: JSON.stringify({
              jobId: this.jobId,
              dspEnabled: true,
              scheduleId: this.scheduleId,
              candidateId: activeCandidate,
              candidate_id: activeCandidate, // Also include for middleware
              activeApplicationCheckEnabled: true
            })
          }
        );

        clearTimeout(timeoutId); // Clear timeout if successful
        
        // [IP TRACKING] Capture IP from Proxy Header
        const usedIP = createapplication.headers.get('X-Executor-IP');
        if (usedIP) this.lastKnownIP = usedIP;
        
        // [Task 4] Handle 429/403 -> Swap
        if (createapplication.status === 429 || createapplication.status === 403 || createapplication.headers.get('X-Candidate-Paused-Until')) {
          const pausedUntil = createapplication.headers.get('X-Candidate-Paused-Until');
          const candIdSafe = activeCandidate || "N/A";
          console.log(`${this.logPrefix} ⚠️ Rate limited (429/403) for candidate ${candIdSafe}`);
          
          // Throw sentinel error to trigger swap
          const err = new Error("switching candidate due to rate limit");
          err.code = "ROTATE_BOTH";
          throw err;
        }

        // Drop instantly on 504 Timeout or other errors
        if (!createapplication.ok || createapplication.status === 504) {
          const errorText = await createapplication.text().catch(()=>"");
          await delay(20); // Minimal retry delay
          continue;
        }

        const createData = await createapplication.json();
        
        if (createData.data && createData.data.applicationId) {
          const applicationId = createData.data.applicationId;
          console.log(`${this.logPrefix} ✅ App created: ${applicationId}`);
          return applicationId;
        } else if (createData.errorCode === "APPLICATION_ALREADY_EXIST_CAN_BE_RESET" && createData.errorMetadata) {
          const applicationId = createData.errorMetadata.applicationId;
          console.log(`${this.logPrefix} ✅ App exists: ${applicationId}`);
          return applicationId;
        } else {
          console.log(`${this.logPrefix} ❌ Create failed, retrying...`);
          await delay(20);
          continue;
        }
      } catch (err) {
        clearTimeout(timeoutId); // Clean up timeout

        // Re-throw our control flow errors
        if (err?.code === "ROTATE_BOTH" || err?.code === "ROTATE_IP_ONLY") {
          throw err;
        }

        // If it was aborted by our 2.5s timer, loop immediately and quietly
        if (err.name === 'AbortError') {
          continue;
        }
        
        await delay(20);
      }
    }
    
    throw new Error("stopped");
  }

  // Phase 2: Connect WebSocket
  async phase2ConnectWebSocket({ applicationId, candidateId, authToken }) {
    const uref = `https://${this.domain}/application/${this.countryCode.toLowerCase()}/?applicationId=${applicationId}&jobId=${this.jobId}`;
    
    const completeTaskMessage = {
      action: "completeTask",
      applicationId,
      candidateId: candidateId,
      requisitionId: "",
      jobId: this.jobId,
      state: "MN",
      employmentType: "Regular",
      eventSource: "HVH-CA-UI",
      jobSelectedOn: new Date().toISOString(),
      currentWorkflowStep: "job-opportunities",
      workflowStepName: "",
      partitionAttributes: { countryCodes: this.countryCodes },
      filteringSeasonal: false,
      filteringRegular: false
    };

    const startWorkflowMessage = {
      action: "startWorkflow",
      applicationId,
      candidateId: candidateId,
      jobId: this.jobId,
      scheduleId: this.scheduleId,
      partitionAttributes: { countryCodes: this.countryCodes },
      filteringSeasonal: false,
      filteringRegular: false
    };

    // Store messages for use in Phase 3
    this.completeTaskMessage = completeTaskMessage;
    this.startWorkflowMessage = startWorkflowMessage;
    this.uref = uref;

    const urlEncodedToken = encodeURIComponent(authToken);
    const wsUrl = `wss://ufatez9oyf.execute-api.us-east-1.amazonaws.com/prod?applicationId=${applicationId}&candidateId=${candidateId}&authToken=${urlEncodedToken}`;
    
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(wsUrl);
      
      this.socket.onopen = () => {
        console.log(`${this.logPrefix} ✅ WebSocket connected`);
        resolve();
      };

      this.socket.onmessage = (event) => {
        try {
          const messageData = JSON.parse(event.data);
          if (messageData.stepName === "job-opportunities") {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
              this.socket.send(JSON.stringify(completeTaskMessage));
            }
          } else if (messageData.stepName === "general-questions") {
            console.log(`${this.logPrefix} ✅ Workflow progressed!`);
          } else if (messageData.message === "Internal server error") {
            console.log(`${this.logPrefix} ❌ Server error`);
          }
        } catch (e) {
          console.log(`${this.logPrefix} ❌ WebSocket parse error`);
        }
      };
  
      this.socket.onerror = (error) => {
        console.error(`${this.logPrefix} ❌ WebSocket error:`, error);
        reject(error);
      };

      this.socket.onclose = (event) => {
        console.log(`${this.logPrefix} 🔌 WebSocket closed. Code:`, event.code);
      };
    });
  }

  // Phase 3: Update loop
  async phase3UpdateLoop({ candidate, applicationId }) {
    console.log(`${this.logPrefix} 🔄 Starting AGGRESSIVE update loop...`);
    
    while (!this.stopped && this.isRunning) {
      // Check Rule 2: Jittered Timer
      if (Date.now() - this.startTime > this.currentTimerLimit) { 
          const err = new Error("Jittered timer reached");
          err.code = "ROTATE_IP_ONLY";
          throw err;
      }

      this.requestCount++;
      
      // [NEW] 2.5 Second Client-Side Kill Switch
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);

      try {
        const proxyUrl = await getProxyUrl();
        
        // Inject custom header if Rule 2 triggered inside phase 3
        const reqHeaders = { 
          ...this.baseHeaders, 
          referer: this.uref,
          'x-candidate-id': candidate
        };
        if (this.forceIpRotation) {
          reqHeaders['x-force-ip-rotation'] = 'true';
          this.forceIpRotation = false; 
        }

        const updatePromise = await fetch(
          `${proxyUrl}/application/api/candidate-application/update-application`,
          {
            method: "PUT",
            headers: reqHeaders,
            signal: controller.signal, // Bind the abort controller
            body: JSON.stringify({
              applicationId,
              candidateId: candidate,
              candidate_id: candidate,
              payload: {
                jobId: this.jobId,
                scheduleId: this.scheduleId
              },
              type: "job-confirm",
              isCsRequest: true,
              dspEnabled: true
            })
          }
        );

        clearTimeout(timeoutId); // Clear timeout if successful
        
        // [IP TRACKING] Capture IP from Proxy Header
        const usedIP = updatePromise.headers.get('X-Executor-IP');
        if (usedIP) this.lastKnownIP = usedIP;
        
        // [Task 4] Handle 429/403 -> Swap
        if (updatePromise.status === 429 || updatePromise.status === 403 || updatePromise.headers.get('X-Candidate-Paused-Until')) {
          const pausedUntil = updatePromise.headers.get('X-Candidate-Paused-Until');
          const candIdSafe = candidate || "N/A";
          console.log(`${this.logPrefix} ⚠️ Rate limited (429/403) for candidate ${candIdSafe}`);
          
          // Throw sentinel error to trigger swap
          const err = new Error("switching candidate due to rate limit");
          err.code = "ROTATE_BOTH";
          throw err;
        }

        // Drop instantly on 504 Timeout or other errors
        if (!updatePromise.ok || updatePromise.status === 504) {
          const errorText = await updatePromise.text().catch(()=>"");
          continue; 
        }
        
        const data = await updatePromise.json();
        
        if (data.message === 'Too many requests, please try again later') {
          // Throw sentinel error to trigger swap
          const err = new Error("switching candidate due to rate limit message");
          err.code = "ROTATE_BOTH";
          throw err;
        } else if (data.errorCode === "SELECTED_SCHEDULE_NOT_AVAILABLE") {
          if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(this.startWorkflowMessage));
          }
          // Continue loop immediately
        } else {
          // Success! But continue polling
          if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(this.startWorkflowMessage));
          }
          const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
          console.log(`${this.logPrefix} 🎯 SUCCESS in ${this.requestCount} requests (${elapsed}s) - continuing...`);
          // Continue loop immediately
        }
        
        // Simple status every 10 requests to reduce console spam
        if (!this.stopped && this.requestCount % 10 === 0) {
          console.log(`${this.logPrefix} 🔄 Req${this.requestCount} (Aggressive)`);
        }
        
      } catch (updateError) {
        clearTimeout(timeoutId); // Clean up timeout

        // Re-throw our control flow errors
        if (updateError?.code === "ROTATE_BOTH" || updateError?.code === "ROTATE_IP_ONLY") {
          throw updateError;
        }

        // If it was aborted by our 2.5s timer, loop immediately and quietly
        if (updateError.name === 'AbortError') {
          continue;
        }
        
        const candIdSafe = candidate || "N/A";
        console.log(`${this.logPrefix} ❌ Error on request ${this.requestCount}`, updateError.message || updateError);
        await delay(50); // Minimal safety delay on network errors
      }
    }
  }

  stop() {
    this.isRunning = false;
    this.stopped = true;
    this.resetApplicationState();
    
    // [NEW] Release candidate lock on stop
    if (this.currentCandidate) {
      inUseCandidates.delete(this.currentCandidate);
      this.currentCandidate = null;
    }
    
    console.log(`${this.logPrefix} 🛑 Local poller stopped`);
  }
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  function (details) {
    for (let header of details.requestHeaders) {
      const headerName = header.name.toLowerCase();
      if (headerName === "authorization" && header.value.startsWith("AQICAH")) {
        authToken = header.value;
      } else if (headerName === "cookie" && header.value.includes("adobe-session-id")) {
        cookieHeader = header.value;
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

async function getLatestCookies() {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ domain: "hiring.amazon.com" }, (cookies) => {
      if (!cookies) {
        resolve(null);
        return;
      }
      const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
      resolve(cookieString);
    });
  });
}

let cookieUpdateTimeout = null;
chrome.cookies.onChanged.addListener((changeInfo) => {
  if (changeInfo.cookie.domain.includes("hiring.amazon.com")) {
    clearTimeout(cookieUpdateTimeout);
    cookieUpdateTimeout = setTimeout(() => {
      getLatestCookies().then(cookies => {
        if (cookies !== cookieHeader) {
          cookieHeader = cookies;
        }
      });
    }, 500);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SET_SCHEDULE_START") {
    console.log('📨 Received SET_SCHEDULE_START message:', message);
    const response = {
      success: false,
      message: "SET_SCHEDULE_START deprecated - use SET_JOB_COMBINATIONS instead",
      combinations: 0
    };
    
    console.log('📤 Sending response:', response);
    sendResponse(response);
  } else if (message.type === "SET_JOB_COMBINATIONS") {
    console.log('📨 Received SET_JOB_COMBINATIONS message:', message);
    predefinedJobs = message.combinations || [];
    successfulJobs.clear(); // Reset successful jobs for new combinations
    
    const response = {
      success: true,
      message: `Job combinations set: ${predefinedJobs.length} combinations`,
      combinations: predefinedJobs.length
    };
    
    console.log('📤 Sending response:', response);
    sendResponse(response);
  } else if (message.type === "GET_PREDEFINED_JOBS") {
    sendResponse({ jobs: predefinedJobs });
  } else if (message.type === "REFRESH_CANDIDATE_ID") {
    console.log("🔄 Manual candidateId refresh requested");
    chrome.storage.local.get(["candidateId"], (res) => {
      console.log("🔍 Manual refresh - Storage lookup result:", res);
      if (res && res.candidateId) {
        candidateId = res.candidateId;
        console.log("✅ CandidateId refreshed from storage:", candidateId);
        sendResponse({ success: true, candidateId: candidateId });
      } else {
        candidateId = null;
        console.log("❌ No candidateId found during manual refresh");
        sendResponse({ success: false, candidateId: null });
      }
    });
    return true; // Keep message channel open for async response
  } else if (message.type === "GET_AUTH_STATUS") {
    console.log("📋 GET_AUTH_STATUS - Current candidateId:", candidateId);
    const response = {
      hasAuth: !!(authToken && cookieHeader),
      authToken: authToken ? authToken.substring(0, 20) + "..." : "NOT SET",
      cookieHeader: cookieHeader ? "SET" : "NOT SET",
      candidateId: candidateId,
      fullAuthToken: authToken || "NOT SET",
      fullCookieHeader: cookieHeader || "NOT SET"
    };
    console.log("📤 GET_AUTH_STATUS response:", response);
    sendResponse(response);
  } else if (message.type === "SET_INSTANCE_MANAGER_URL") {
    sendResponse({ ok: true, url: INSTANCE_MANAGER_URL });
  } else if (message.type === "GET_HEALTH_SUMMARY") {
    const localPollerStatus = Array.from(localPollers.entries()).map(([pollerId, poller]) => ({
      pollerId,
      jobId: poller.jobId,
      scheduleId: poller.scheduleId,
      applicationId: poller.applicationId,
      isRunning: poller.isRunning,
      type: 'local'
    }));
    
    const healthSummary = {
      totalInstances: awsInstances.size,
      totalLocalPollers: localPollers.size,
      instanceDetails: Array.from(awsInstances.entries()).map(([key, instance]) => ({
        key, jobId: instance.jobId, scheduleId: instance.scheduleId,
        status: instance.status,
        createdAt: instance.createdAt,
        errorCount: instance.errorCount || 0,
        type: 'aws'
      })),
      localPollerDetails: localPollerStatus,
      lastUpdated: new Date().toISOString()
    };
    sendResponse({ healthSummary });
  } else if (message.action === "start") {
    if (predefinedJobs.length === 0) {
      sendResponse({ status: "failed", error: "No combinations generated" });
      return true;
    }
    
    // Choose between local polling and AWS instances
    const useLocalPolling = message.useLocalPolling || false;
    
    if (useLocalPolling) {
      // Use local polling logic
      (async () => {
        console.log(`🚀 Starting local polling for ${predefinedJobs.length} job combinations...`);
        console.log('🔍 Available jobs:', predefinedJobs.slice(0, 3));
        console.log('🔑 Auth check before polling:', {
          hasAuthToken: !!authToken,
          hasCookieHeader: !!cookieHeader,
          candidateId: candidateId
        });
        
        let successfulCount = 0;
        let remainingJobs = predefinedJobs.filter(job => !successfulJobs.has(`${job.jobId}-${job.scheduleId}`));
        
        // If we have jobs but all are marked successful (e.g. restart), force run all
        if (remainingJobs.length === 0 && predefinedJobs.length > 0) {
           remainingJobs = predefinedJobs;
        }

        console.log(`📊 Remaining jobs to process: ${remainingJobs.length}`);
        
        for (const job of remainingJobs) {
          if (stopped) {
            console.log('🛑 Polling stopped by user');
            break;
          }
          
          console.log(`🎯 Processing job: ${job.jobId}/${job.scheduleId}`);
          
          try {
            // Force 0 pollingInterval for aggressive
            const poller = new LocalPoller(job.jobId, job.scheduleId, 0);
            localPollers.set(poller.pollerId, poller);
            console.log(`📝 Created poller with ID: ${poller.pollerId}`);
            
            // Start async to run parallel
            poller.start().catch(e => console.error("Poller runtime error", e));
            
            successfulJobs.add(`${job.jobId}-${job.scheduleId}`);
            successfulCount++;
            console.log(`✅ Local poller started for ${job.jobId}/${job.scheduleId}`);
            
            // Minimal delay between starting pollers
            await delay(100); 
          } catch (error) {
            console.error(`❌ Failed to start local poller for ${job.jobId}/${job.scheduleId}:`, error);
          }
        }
        
        // Notify UI
        sendResponse({
          status: "started",
          message: "Local polling initiated (Aggressive)",
          total: predefinedJobs.length,
          pollingType: "local"
        });

      })();
      return true;
      
    } else {
      // Use AWS instances (original logic)
      (async () => {
      const BATCH_SIZE = 10;
      let allResults = [];
      let successfulCount = 0;
      console.log(`🚀 Starting creation of AWS instances...`);
      let remainingJobs = predefinedJobs.filter(job => !successfulJobs.has(`${job.jobId}-${job.scheduleId}`));

      for (let i = 0; i < remainingJobs.length; i += BATCH_SIZE) {
        const batch = remainingJobs.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(remainingJobs.length / BATCH_SIZE);
        console.log(`📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} instances)...`);
        const batchPromises = batch.map(async (job) => {
          if (stopped) return { success: false, error: "Stopped" };
          try {
            const response = await fetchWithRetry(INSTANCE_MANAGER_URL + '/start', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jobId: job.jobId,
                scheduleId: job.scheduleId,
                instanceType: 't3.micro',
                candidateId,
                authToken,
                cookieHeader,
                pollingInterval: message.pollingInterval || 0 // 0 for aggressive
              })
            }, 3, 100000);
            const data = await response.json();
            if (!data.success || !data.instanceId) {
              throw new Error(`Invalid Lambda response: ${JSON.stringify(data)}`);
            }
            const ec2InstanceId = data.instanceId;
            const instanceKey = `${job.jobId}-${job.scheduleId}-${Date.now()}`;
            awsInstances.set(instanceKey, {
              jobId: job.jobId,
              scheduleId: job.scheduleId,
              instanceKey,
              status: 'creating',
              createdAt: new Date(),
              ec2InstanceId
            });
            successfulJobs.add(`${job.jobId}-${job.scheduleId}`);
            console.log(`✅ EC2 instance created for ${job.jobId}/${job.scheduleId}: ${ec2InstanceId}`);
            return {
              success: true,
              jobId: job.jobId,
              scheduleId: job.scheduleId,
              instanceId: ec2InstanceId,
              ec2InstanceId
            };
          } catch (error) {
            console.error(`❌ Failed to create instance for ${job.jobId}/${job.scheduleId}: ${error.message}`);
            if (error.message.includes('VcpuLimitExceeded')) {
              stopped = true;
              return { success: false, error: 'vCPU limit exceeded' };
            }
            return { success: false, error: error.message, jobId: job.jobId, scheduleId: job.scheduleId };
          }
        });
        const batchResults = await Promise.allSettled(batchPromises);
        successfulCount += batchResults.filter(r => r.status === 'fulfilled' && r.value && r.value.success).length;
        allResults.push(...batchResults.map(r => r.value || { error: r.reason }));
        if (stopped) break;
        await delay(5000); // 5s delay between batches
      }
      
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.url && (tab.url.includes("hiring.amazon") || tab.url.includes("amazon.com"))) {
            chrome.tabs.sendMessage(tab.id, {
              type: "BATCH_COMPLETE",
              status: "instances_created",
              message: "Instance creation completed",
              total: predefinedJobs.length,
              successful: successfulCount,
              instances: allResults
            }).catch(err => console.error(`Failed to send message: ${err.message}`));
          }
        });
      });
    })();
      
    sendResponse({
      status: "started",
      message: "Batch processing initiated",
      total: predefinedJobs.length,
      pollingType: "aws"
    });
    }
  } else if (message.action === "stop") {
    stopped = true;
    (async () => {
      // Stop local pollers
      for (const [pollerId, poller] of localPollers) {
        poller.stop();
        localPollers.delete(pollerId);
      }
      
      // Stop AWS instances
      const instanceKeys = Array.from(awsInstances.keys());
      await Promise.all(instanceKeys.map(async (key) => {
        const instance = awsInstances.get(key);
        if (instance && instance.ec2InstanceId) {
          try {
            await fetchWithRetry(`${INSTANCE_MANAGER_URL}/stop`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ instanceId: instance.ec2InstanceId })
            }, 3, 10000);
            console.log(`✅ Terminated instance ${instance.ec2InstanceId}`);
          } catch (error) {
            console.error(`❌ Error terminating instance ${instance.ec2InstanceId}: ${error.message}`);
          }
        }
        awsInstances.delete(key);
      }));
      
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.url && (tab.url.includes("hiring.amazon") || tab.url.includes("amazon.com"))) {
            chrome.tabs.sendMessage(tab.id, {
              type: "STOP_COMPLETE",
              status: "stopped",
              message: "All instances and local pollers stopped"
            }).catch(err => console.error(`Failed to send message: ${err.message}`));
          }
        });
      });
      successfulJobs.clear(); // Clear successful jobs on stop
    })();
    sendResponse({ status: "stopping", message: "Stopping all pollers and instances" });
  } else if (message.type === "GET_LOCAL_POLLERS_STATUS") {
    const pollerStatus = Array.from(localPollers.entries()).map(([pollerId, poller]) => ({
      pollerId,
      jobId: poller.jobId,
      scheduleId: poller.scheduleId,
      applicationId: poller.applicationId,
      isRunning: poller.isRunning,
      hasWebSocket: !!poller.websocket
    }));
    sendResponse({ 
      localPollers: pollerStatus,
      totalActive: pollerStatus.filter(p => p.isRunning).length
    });
  } else if (message.type === "BOOTSTRAP_SESSION") {
    (async () => {
      const result = await bootstrapCurrentSession();
      sendResponse(result);
    })();
    return true; // Keep channel open for async
  } else if (message.type === "GET_REGISTERED_SESSIONS") {
    (async () => {
      try {
        const proxyUrl = await getProxyUrl();
        const response = await fetch(`${proxyUrl}/sessions`, {
          method: 'GET',
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
          }
        });
        
        // Handle 304 gracefully
        if (response.status === 304) {
          sendResponse({ sessions: registeredCandidates, currentActive: currentActiveCandidateId });
          return;
        }
        
        if (!response.ok) {
          throw new Error(`Failed to load sessions: ${response.status}`);
        }
        
        const sessions = await response.json();
        registeredCandidates = sessions;
        sendResponse({ sessions: registeredCandidates, currentActive: currentActiveCandidateId });
      } catch (error) {
        console.error('Failed to load sessions:', error);
        sendResponse({ sessions: registeredCandidates, currentActive: currentActiveCandidateId });
      }
    })();
    return true;
  } else if (message.type === "SET_PROXY_URL") {
    chrome.storage.local.set({ proxyUrl: message.url }, () => {
      sendResponse({ success: true });
      // Reconnect SSE
      connectSSE();
      loadRegisteredCandidates();
    });
    return true;
  } else if (message.type === "SUBSCRIBE_SESSION_UPDATES") {
    // Add listener for session updates
    const listener = (sessions) => {
      chrome.runtime.sendMessage({
        type: "SESSION_UPDATES",
        sessions: sessions,
        currentActive: currentActiveCandidateId
      }).catch(() => {}); // Ignore if no listener
    };
    sessionUpdateListeners.push(listener);
    // Send current state immediately
    sendResponse({ sessions: registeredCandidates, currentActive: currentActiveCandidateId });
    return true;
  } else if (message.type === "DELETE_SESSION") {
    (async () => {
      const { candidateId: candidateIdToDelete } = message.payload || {};
      if (!candidateIdToDelete) {
        sendResponse({ ok: false, error: "Missing candidateId" });
        return;
      }
      
      try {
        await deleteCandidateSession(candidateIdToDelete);
        await loadRegisteredCandidates();
        sendResponse({ ok: true });
      } catch (e) {
        console.error("DELETE_SESSION failed", e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // Keep channel open for async
  }
  return true;
});