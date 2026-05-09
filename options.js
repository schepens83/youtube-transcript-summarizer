const apiKeyInput = document.getElementById('apiKey');
const saveButton = document.getElementById('saveButton');
const statusDisplay = document.getElementById('status');

// Load the saved API key when the options page opens
chrome.storage.sync.get(['openRouterApiKey'], (result) => {
  if (result.openRouterApiKey) {
    apiKeyInput.value = result.openRouterApiKey;
  }
});

saveButton.addEventListener('click', () => {
  const apiKey = apiKeyInput.value.trim();
  if (apiKey) {
    chrome.storage.sync.set({ openRouterApiKey: apiKey }, () => {
      statusDisplay.textContent = 'Settings saved successfully!';
      statusDisplay.style.color = 'green';
      setTimeout(() => {
        statusDisplay.textContent = '';
      }, 2000); // Clear message after 2 seconds
    });
  } else {
    // Optionally, allow clearing the key
    chrome.storage.sync.remove('openRouterApiKey', () => {
      statusDisplay.textContent = 'API key cleared.';
      statusDisplay.style.color = 'orange';
      apiKeyInput.value = ''; // Clear input field as well
      setTimeout(() => {
        statusDisplay.textContent = '';
      }, 2000);
    });
  }
});