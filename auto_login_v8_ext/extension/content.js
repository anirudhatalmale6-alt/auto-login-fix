// Content script for Amazon Hiring Portal — monitors localStorage for tokens

// Global error handling to prevent crashes
window.addEventListener('error', (event) => {
  console.error('Uncaught error:', event.error);
  event.preventDefault();
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  event.preventDefault();
});

// Helper function to check if extension context is valid
function isExtensionContextValid() {
  try {
    return chrome && chrome.runtime && chrome.runtime.id;
  } catch (e) {
    return false;
  }
}

function monitorLocalStorage() {
  const checkForTokens = () => {
    // Check if extension context is still valid
    if (!isExtensionContextValid()) {
      console.log("⚠️ Extension context invalidated, skipping localStorage check");
      return;
    }
    
    // Check for candidate ID
    const candidateId =
      localStorage.getItem("bbCandidateId") ||
      localStorage.getItem("sfCandidateId") ||
      localStorage.getItem("CandidateId");

    console.log("🔍 Checking localStorage for candidateId...");
    console.log("bbCandidateId:", localStorage.getItem("bbCandidateId"));
    console.log("sfCandidateId:", localStorage.getItem("sfCandidateId"));
    console.log("CandidateId:", localStorage.getItem("CandidateId"));

    if (candidateId) {
      chrome.storage.local.set({ candidateId: candidateId }, () => {
        console.log("✅ Captured and stored candidate ID:", candidateId);
      });
    } else {
      console.log("❌ No candidateId found in localStorage");
    }

    // Check for access token in localStorage
    const accessToken = localStorage.getItem("accessToken");
    if (
      accessToken &&
      accessToken.startsWith("AQICAH") &&
      accessToken.length >= 1000
    ) {
      chrome.storage.local.set({ accessToken: accessToken });
      console.log(
        "✅ Captured access token from localStorage:",
        accessToken.substring(0, 20) + "..."
      );
    }
  };

  // Check immediately and then periodically
  checkForTokens();
  setInterval(checkForTokens, 2000);
}
// Minimal content script - all logic moved to background.js
// This script only handles message passing
monitorLocalStorage();
// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Check if extension context is still valid
  if (!isExtensionContextValid()) {
    console.log("⚠️ Extension context invalidated, ignoring message");
    return;
  }
  
  // Handle any messages that need DOM access
  if (message.type === "BATCH_COMPLETE") {
    console.log("Batch processing completed:", message);
  } else if (message.type === "SINGLE_JOB_COMPLETE") {
    console.log("Single job completed:", message);
  } else if (message.type === "STOP_COMPLETE") {
    console.log("All instances stopped:", message);
  } else if (message.type === "AWS_DIAGNOSTIC_COMPLETE") {
    console.log("AWS diagnostic completed:", message);
  } else if (message.type === "UPDATE_AUTH_TOKEN") {
    // Auth token updated in background script
    console.log("Auth token updated from background script");
  } else if (message.type === "UPDATE_COOKIE_HEADER") {
    // Cookie header updated in background script
    console.log("Cookie header updated from background script");
  }
  
  sendResponse({ received: true });
  return true;
});

// Send ping to background script to confirm content script is loaded
if (isExtensionContextValid()) {
  chrome.runtime.sendMessage({
    type: "CONTENT_SCRIPT_READY",
    url: window.location.href,
    timestamp: Date.now()
  }).catch(err => {});
}

console.log("Content script loaded - all logic moved to background.js");