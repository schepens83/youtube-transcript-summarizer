// --- Constants ---
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL_NAME = 'google/gemini-2.5-flash-lite'; // Using a smaller, faster model

// --- State ---
let summaryModalElement = null;

// --- Helper Functions ---

// Function to get the API key from storage
async function getApiKey() {
  const result = await chrome.storage.sync.get(['openRouterApiKey']);
  return result.openRouterApiKey;
}

// Function to fetch transcript data directly from the DOM
async function fetchTranscript() {
  console.log("Attempting to fetch transcript from DOM...");

  return new Promise((resolve, reject) => {
    const maxRetries = 10; // Try for 5 seconds (10 retries * 500ms)
    let retries = 0;

    const extractText = () => {
      // Look for the segments container, which holds all transcript segments.
      // The segments themselves are within ytd-transcript-segment-renderer elements.
      const transcriptSegments = document.querySelectorAll('ytd-transcript-segment-renderer .segment-text');

      if (transcriptSegments.length > 0) {
        let fullTranscript = "";
        transcriptSegments.forEach(segment => {
          fullTranscript += segment.textContent.trim() + " ";
        });
        console.log(`Successfully extracted ${transcriptSegments.length} transcript segments from DOM.`);
        resolve(fullTranscript.trim());
      } else if (retries < maxRetries) {
        // If not found yet, wait a bit and check again.
        retries++;
        setTimeout(extractText, 500); // Wait 500ms before retrying
      } else {
        reject("Transcript segments not found in DOM after multiple attempts.");
      }
    };

    extractText(); // Start the extraction process
  });
}

// Function to call OpenRouter API for summarization
async function summarizeTranscript(transcriptText) {
  console.log("Attempting to summarize transcript...");
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error("OpenRouter API key not set. Please set it in the extension's options.");
  }

  const prompt = `Summarize the following YouTube video transcript concisely. Focus on the main points and key takeaways. Return at max 3 paragraphs or 15 sentences. Prefer short bulletpoint format.\n\nTranscript:\n"${transcriptText}"`;

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error(`API Error: ${response.status} - ${errorData.error?.message || response.statusText}`);
      throw new Error(`API request failed: ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    console.log("API response received.");
    return data.choices[0].message.content;
  } catch (error) {
    console.error("Error during summarization:", error);
    throw error;
  }
}

// Function to create and display the summary modal
function displaySummaryModal(summary) {
  console.log("Displaying summary modal...");
  if (summaryModalElement) {
    summaryModalElement.remove();
  }

  summaryModalElement = document.createElement('div');
  summaryModalElement.id = 'youtube-transcript-summarizer-modal';
  summaryModalElement.innerHTML = `
    <div class="modal-content">
      <span class="close-button">&times;</span>
      <h2>Video Summary</h2>
      <div class="summary-text">${summary}</div>
    </div>
  `;

  document.body.appendChild(summaryModalElement);

  summaryModalElement.querySelector('.close-button').addEventListener('click', () => {
    summaryModalElement.remove();
    summaryModalElement = null;
  });

  makeModalDraggable(summaryModalElement.querySelector('.modal-content'));
}

// Function to make the modal content draggable
function makeModalDraggable(element) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  const header = element.querySelector('h2');

  if (header) {
    header.onmousedown = dragMouseDown;
  } else {
    element.onmousedown = dragMouseDown;
  }

  function dragMouseDown(e) {
    e = e || window.event;
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }

  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    element.style.top = (element.offsetTop - pos2) + "px";
    element.style.left = (element.offsetLeft - pos1) + "px";
  }

  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
  }
}

// --- Event Listener for Hotkey Command ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "summarizeVideo") {
    console.log("Content script received 'summarizeVideo' action.");
    fetchTranscript()
      .then(transcriptText => {
        if (!transcriptText || transcriptText.trim().length === 0) {
          throw new Error("Transcript is empty or could not be extracted.");
        }
        return summarizeTranscript(transcriptText);
      })
      .then(summary => {
        displaySummaryModal(summary);
        sendResponse({ status: "success", message: "Summary displayed." });
      })
      .catch(error => {
        console.error("Failed to process or display summary:", error);
        displaySummaryModal(`Error: ${error.message || 'Failed to get video summary.'}`);
        sendResponse({ status: "error", message: error.message || 'Failed to get video summary.' });
      });
    return true;
  }
});

console.log("Content script loaded.");