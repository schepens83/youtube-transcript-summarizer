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

  const existingTranscript = await waitForTranscriptText(1);
  if (existingTranscript) {
    return existingTranscript;
  }

  const opened = await openTranscriptPanel();
  if (!opened) {
    throw new Error('Could not find or click the "Show transcript" control.');
  }

  const transcriptText = await waitForTranscriptText(10);
  if (!transcriptText) {
    throw new Error("Transcript segments not found in DOM after multiple attempts.");
  }

  return transcriptText;
}

function extractTranscriptText() {
  // Support both the older Polymer transcript DOM and YouTube's newer view-model transcript DOM.
  const transcriptSegments = document.querySelectorAll('ytd-transcript-segment-renderer .segment-text, transcript-segment-view-model span[role=text]');

  if (transcriptSegments.length === 0) {
    return "";
  }

  const transcriptText = [...transcriptSegments]
    .map(segment => segment.textContent.trim())
    .filter(Boolean)
    .join(" ");

  console.log(`Successfully extracted ${transcriptSegments.length} transcript segments from DOM.`);
  return transcriptText;
}

async function waitForTranscriptText(maxAttempts) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const transcriptText = extractTranscriptText();
    if (transcriptText) {
      return transcriptText;
    }

    if (attempt < maxAttempts) {
      await delay(500);
    }
  }

  return "";
}

async function openTranscriptPanel() {
  if (await clickShowTranscriptControl()) {
    return true;
  }

  await expandDescription();

  return clickShowTranscriptControl();
}

async function expandDescription() {
  const selectors = [
    'tp-yt-paper-button#expand',
    'ytd-text-inline-expander tp-yt-paper-button#expand',
    '#description-inline-expander button',
  ];

  for (const selector of selectors) {
    const control = document.querySelector(selector);
    if (isVisibleElement(control)) {
      control.click();
      await delay(500);
      return;
    }
  }

  const moreButton = findVisibleElementByText(document.getElementsByTagName('button'), /^more$/i);
  if (moreButton) {
    moreButton.click();
    await delay(500);
  }
}

async function clickShowTranscriptControl() {
  const control = findShowTranscriptControl();
  if (!control) {
    return false;
  }

  const clickable = control.closest('button') || control.getElementsByTagName('button')[0] || control;
  clickable.click();
  await delay(1000);
  return true;
}

function findShowTranscriptControl() {
  const tagNames = ['button', 'ytd-button-renderer', 'yt-button-shape', 'tp-yt-paper-button'];

  for (const tagName of tagNames) {
    const control = findVisibleElementByText(document.getElementsByTagName(tagName), /show transcript/i);
    if (control) {
      return control;
    }
  }

  return null;
}

function findVisibleElementByText(elements, pattern) {
  return [...elements].find(element => {
    const label = `${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`;
    return isVisibleElement(element) && pattern.test(label.trim());
  });
}

function isVisibleElement(element) {
  if (!element) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to call OpenRouter API for summarization
async function summarizeTranscript(transcriptText) {
  console.log("Attempting to summarize transcript...");
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error("OpenRouter API key not set. Please set it in the extension's options.");
  }

  const prompt = `Summarize the following YouTube video transcript. Structure your response exactly like this:

1. A single short paragraph (2-3 sentences max) giving the overall gist.
2. A blank line.
3. 5-8 bullet points (using "- ") covering the main arguments, findings, or takeaways. Each bullet should be one concise sentence. Bold the key term or phrase in each bullet using **bold**.

No headers, no extra commentary, just the paragraph then the bullets.

Transcript:
"${transcriptText}"`;

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

function renderMarkdown(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = escaped.split('\n');
  const html = [];
  let inList = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^- /.test(line)) {
      if (!inList) { html.push('<ul>'); inList = true; }
      html.push(`<li>${line.slice(2).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</li>`);
    } else {
      if (inList) { html.push('</ul>'); inList = false; }
      if (line === '') {
        html.push('<br>');
      } else {
        html.push(`<p>${line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>`);
      }
    }
  }
  if (inList) html.push('</ul>');
  return html.join('');
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
      <div class="summary-text">${renderMarkdown(summary)}</div>
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
