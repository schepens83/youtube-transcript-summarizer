// Listen for the extension's action button (toolbar icon) click
chrome.action.onClicked.addListener(async (tab) => {
  console.log("Extension icon clicked.");
  // Ensure it's a YouTube watch page before proceeding
  if (tab && tab.url && tab.url.includes("youtube.com/watch")) {
    console.log("Sending 'summarizeVideo' action to content script via extension click.");
    try {
      await sendSummarizeMessage(tab.id);
    } catch (error) {
      console.error("Error sending message to content script:", error);
    }
  } else {
    console.log("Not on a YouTube watch page, action ignored.");
  }
});

async function sendSummarizeMessage(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "summarizeVideo" });
  } catch (error) {
    if (!/Receiving end does not exist/i.test(error.message || "")) {
      throw error;
    }

    console.log("Content script was not available; injecting it and retrying.");
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["modal.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    await chrome.tabs.sendMessage(tabId, { action: "summarizeVideo" });
  }
}

console.log("Background script loaded and listening for icon clicks.");
