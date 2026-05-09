// Listen for the extension's action button (toolbar icon) click
chrome.action.onClicked.addListener(async (tab) => {
  console.log("Extension icon clicked.");
  // Ensure it's a YouTube watch page before proceeding
  if (tab && tab.url && tab.url.includes("youtube.com/watch")) {
    console.log("Sending 'summarizeVideo' action to content script via extension click.");
    try {
      // Send a message to the content script to initiate the process
      await chrome.tabs.sendMessage(tab.id, { action: "summarizeVideo" });
    } catch (error) {
      console.error("Error sending message to content script:", error);
    }
  } else {
    console.log("Not on a YouTube watch page, action ignored.");
  }
});

console.log("Background script loaded and listening for icon clicks.");