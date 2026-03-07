const fs = require('fs');

const logStream = fs.createWriteStream('job_picker.log', { flags: 'a' });

function log(level, tag, message) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] [${tag}] ${message}`;
  console.log(line);
  logStream.write(line + '\n');
}

module.exports = {
  info: (tag, msg) => log('INFO', tag, msg),
  warn: (tag, msg) => log('WARN', tag, msg),
  error: (tag, msg) => log('ERROR', tag, msg),
  debug: (tag, msg) => log('DEBUG', tag, msg),
  success: (tag, msg) => log('SUCCESS', tag, msg),
};
