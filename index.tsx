/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import {GoogleGenAI, Type} from '@google/genai';
import * as pdfjsLib from 'pdfjs-dist';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import {jsPDF} from 'jspdf';

// Set worker path for pdf.js
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.mjs`;

interface Flashcard {
  term: string;
  definition: string;
  mnemonic: string;
}

// --- DOM Element References ---
// Mode switcher
const textModeButton = document.getElementById(
  'textModeButton',
) as HTMLButtonElement;
const pdfModeButton = document.getElementById('pdfModeButton') as HTMLButtonElement;

// Input containers
const textInputContainer = document.getElementById(
  'textInputContainer',
) as HTMLDivElement;
const pdfInputContainer = document.getElementById(
  'pdfInputContainer',
) as HTMLDivElement;
const pdfPageSelectorContainer = document.getElementById(
  'pdfPageSelectorContainer',
) as HTMLDivElement;

// Inputs
const topicInput = document.getElementById('topicInput') as HTMLTextAreaElement;
const pdfInput = document.getElementById('pdfInput') as HTMLInputElement;
const pdfPageInput = document.getElementById('pdfPageInput') as HTMLInputElement;
const pdfFileName = document.getElementById('pdfFileName') as HTMLDivElement;

// Main elements
const generateButton = document.getElementById(
  'generateButton',
) as HTMLButtonElement;
const cancelButton = document.getElementById('cancelButton') as HTMLButtonElement;
const exportPdfButton = document.getElementById(
  'exportPdfButton',
) as HTMLButtonElement;
const flashcardsContainer = document.getElementById(
  'flashcardsContainer',
) as HTMLDivElement;
const errorMessage = document.getElementById('errorMessage') as HTMLDivElement;
const loader = document.getElementById('loader') as HTMLDivElement;
const progressContainer = document.getElementById('progressContainer') as HTMLDivElement;
const progressBar = document.getElementById('progressBar') as HTMLDivElement;
const progressText = document.getElementById('progressText') as HTMLSpanElement;


// --- State ---
let currentMode: 'text' | 'pdf' = 'text';
let selectedPdfFile: File | null = null;
let generatedFlashcards: Flashcard[] = [];
let abortController: AbortController | null = null;


// --- Gemini API Initialization ---
const ai = new GoogleGenAI({apiKey: process.env.API_KEY});

// --- Functions ---
const setMode = (mode: 'text' | 'pdf') => {
  currentMode = mode;
  if (mode === 'text') {
    textModeButton.classList.add('active');
    textModeButton.setAttribute('aria-pressed', 'true');
    pdfModeButton.classList.remove('active');
    pdfModeButton.setAttribute('aria-pressed', 'false');
    textInputContainer.classList.remove('hidden');
    pdfInputContainer.classList.add('hidden');
    generateButton.textContent = 'Generate Flashcards';
  } else {
    pdfModeButton.classList.add('active');
    pdfModeButton.setAttribute('aria-pressed', 'true');
    textModeButton.classList.remove('active');
    textModeButton.setAttribute('aria-pressed', 'false');
    pdfInputContainer.classList.remove('hidden');
    textInputContainer.classList.add('hidden');
    generateButton.textContent = 'Generate from PDF';
  }
  // Clear inputs and errors when switching modes
  topicInput.value = '';
  pdfInput.value = ''; // Resets file input
  selectedPdfFile = null;
  generatedFlashcards = [];
  pdfFileName.textContent = '';
  pdfPageSelectorContainer.classList.add('hidden'); // Hide page selector
  pdfPageInput.value = ''; // Clear page input
  errorMessage.textContent = '';
  flashcardsContainer.innerHTML = '';
  exportPdfButton.classList.add('hidden');
};

/**
 * Parses a page selection string (e.g., "1, 3, 5-8") into an array of page numbers.
 * @param selection The user-provided page selection string.
 * @param maxPages The total number of pages in the PDF.
 * @returns A sorted array of unique page numbers to process.
 */
const parsePageSelection = (selection: string, maxPages: number): number[] => {
  if (!selection.trim()) {
    // If input is empty, return all pages
    return Array.from({length: maxPages}, (_, i) => i + 1);
  }

  const pages = new Set<number>();
  const parts = selection.split(',');

  for (const part of parts) {
    const trimmedPart = part.trim();
    if (trimmedPart.includes('-')) {
      const [start, end] = trimmedPart.split('-').map(Number);
      if (
        !isNaN(start) &&
        !isNaN(end) &&
        start <= end &&
        start > 0 &&
        end <= maxPages
      ) {
        for (let i = start; i <= end; i++) {
          pages.add(i);
        }
      }
    } else {
      const pageNum = Number(trimmedPart);
      if (!isNaN(pageNum) && pageNum > 0 && pageNum <= maxPages) {
        pages.add(pageNum);
      }
    }
  }
  return Array.from(pages).sort((a, b) => a - b);
};

// PDF processing function
const processPdf = async (
  file: File,
  pageSelection: string,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
): Promise<{mimeType: string; data: string}[]> => {
  const fileReader = new FileReader();

  return new Promise((resolve, reject) => {
    // Handle cancellation via signal
    signal.addEventListener('abort', () => {
        fileReader.abort();
        reject(new DOMException('Processing aborted by user', 'AbortError'));
    });
    
    fileReader.onload = async (event) => {
      if (!event.target?.result) {
        return reject(new Error('Failed to read file.'));
      }

      const typedarray = new Uint8Array(event.target.result as ArrayBuffer);
      try {
        const pdf: PDFDocumentProxy = await pdfjsLib.getDocument({data: typedarray})
          .promise;

        const pagesToProcess = parsePageSelection(pageSelection, pdf.numPages);

        if (pagesToProcess.length === 0 && pageSelection.trim() !== '') {
          return reject(
            new Error(
              'Invalid page selection or range is out of bounds.',
            ),
          );
        }

        const imageParts = [];

        for (let i = 0; i < pagesToProcess.length; i++) {
          if (signal.aborted) {
             throw new DOMException('Processing aborted by user', 'AbortError');
          }
          const pageNum = pagesToProcess[i];
          const page = await pdf.getPage(pageNum);
          const viewport = page.getViewport({scale: 1.5}); // Higher scale for better quality
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          if (!context) {
            return reject(new Error('Could not get canvas context.'));
          }
          canvas.height = viewport.height;
          canvas.width = viewport.width;

          await page.render({canvasContext: context, viewport: viewport, canvas: canvas})
            .promise;

          const dataUrl = canvas.toDataURL('image/png');
          const base64Data = dataUrl.split(',')[1];
          imageParts.push({
            mimeType: 'image/png',
            data: base64Data,
          });
          
          // Update progress
          const progress = Math.round(((i + 1) / pagesToProcess.length) * 100);
          onProgress(progress);
        }
        resolve(imageParts);
      } catch (pdfError) {
        reject(pdfError instanceof Error ? pdfError : new Error(`Error processing PDF: ${String(pdfError)}`));
      }
    };

    fileReader.onerror = (error) => reject(error);
    fileReader.readAsArrayBuffer(file);
  });
};

const displayFlashcards = (flashcards: Flashcard[]) => {
  flashcardsContainer.innerHTML = '';
  if (flashcards.length === 0) {
    errorMessage.textContent =
      'No valid flashcards could be generated. Please try a different input.';
    return;
  }
  errorMessage.textContent = '';
  exportPdfButton.classList.remove('hidden');

  flashcards.forEach((flashcard) => {
    const cardDiv = document.createElement('div');
    cardDiv.classList.add('flashcard');
    cardDiv.setAttribute('role', 'button');
    cardDiv.setAttribute(
      'aria-label',
      `Flashcard for ${flashcard.term}. Click to flip.`,
    );
    cardDiv.tabIndex = 0;

    const cardInner = document.createElement('div');
    cardInner.classList.add('flashcard-inner');

    const cardFront = document.createElement('div');
    cardFront.classList.add('flashcard-front');
    const termDiv = document.createElement('div');
    termDiv.classList.add('term');
    termDiv.textContent = flashcard.term;
    cardFront.appendChild(termDiv);

    const cardBack = document.createElement('div');
    cardBack.classList.add('flashcard-back');

    const definitionDiv = document.createElement('div');
    definitionDiv.classList.add('definition');
    definitionDiv.textContent = flashcard.definition;

    const mnemonicContainer = document.createElement('div');
    const mnemonicHeading = document.createElement('div');
    mnemonicHeading.classList.add('mnemonic-heading');
    mnemonicHeading.textContent = 'Mnemonic';
    const mnemonicText = document.createElement('div');
    mnemonicText.classList.add('mnemonic-text');
    mnemonicText.textContent = flashcard.mnemonic;
    mnemonicContainer.appendChild(mnemonicHeading);
    mnemonicContainer.appendChild(mnemonicText);

    cardBack.appendChild(definitionDiv);
    cardBack.appendChild(mnemonicContainer);

    cardInner.appendChild(cardFront);
    cardInner.appendChild(cardBack);
    cardDiv.appendChild(cardInner);

    flashcardsContainer.appendChild(cardDiv);

    const flipCard = () => cardDiv.classList.toggle('flipped');
    cardDiv.addEventListener('click', flipCard);
    cardDiv.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        flipCard();
      }
    });
  });
};

const parseAndDisplayResponse = (responseText: string) => {
    try {
        const parsedJson = JSON.parse(responseText);
        // Ensure the response is an array before processing
        if (Array.isArray(parsedJson)) {
            generatedFlashcards = parsedJson;
            displayFlashcards(generatedFlashcards);
        } else {
            throw new Error('Response from AI is not a valid JSON array.');
        }
    } catch (e) {
        console.error('JSON parsing error:', e);
        errorMessage.textContent = 'Could not understand the response from the AI. Please try again.';
    }
};

// --- Event Listeners ---
textModeButton.addEventListener('click', () => setMode('text'));
pdfModeButton.addEventListener('click', () => setMode('pdf'));

pdfInput.addEventListener('change', () => {
  if (pdfInput.files && pdfInput.files.length > 0) {
    selectedPdfFile = pdfInput.files[0];
    pdfFileName.textContent = `Selected file: ${selectedPdfFile.name}`;
    pdfPageSelectorContainer.classList.remove('hidden');
    pdfPageInput.value = '';
  } else {
    selectedPdfFile = null;
    pdfFileName.textContent = '';
    pdfPageSelectorContainer.classList.add('hidden');
  }
});

cancelButton.addEventListener('click', () => {
    if (abortController) {
        abortController.abort();
    }
});

exportPdfButton.addEventListener('click', () => {
    if (generatedFlashcards.length === 0) return;

    const doc = new jsPDF();
    const cardWidth = 85;
    const cardHeight = 65; // Increased height for mnemonic
    const margin = 10;
    const pageHeight = doc.internal.pageSize.height;
    let x = margin;
    let y = margin;

    generatedFlashcards.forEach((card, index) => {
        if (y + cardHeight > pageHeight - margin) {
            doc.addPage();
            x = margin;
            y = margin;
        }

        doc.rect(x, y, cardWidth, cardHeight);
        doc.setFontSize(12).setFont(undefined, 'bold');
        doc.text(card.term, x + cardWidth / 2, y + 8, { align: 'center' });
        doc.line(x, y + 12, x + cardWidth, y + 12);
        
        doc.setFontSize(8).setFont(undefined, 'normal');
        
        const definitionLines = doc.splitTextToSize(`Definition: ${card.definition}`, cardWidth - 10);
        doc.text(definitionLines, x + 5, y + 18);
        
        const mnemonicY = y + 18 + (definitionLines.length * 4); // Position mnemonic below definition
        const mnemonicLines = doc.splitTextToSize(`Mnemonic: ${card.mnemonic}`, cardWidth - 10);
        doc.setFont(undefined, 'italic');
        doc.text(mnemonicLines, x + 5, mnemonicY);
        doc.setFont(undefined, 'normal');
        
        x += cardWidth + margin;
        if (x + cardWidth > doc.internal.pageSize.width - margin) {
            x = margin;
            y += cardHeight + margin;
        }
    });

    doc.save('flashcards.pdf');
});

generateButton.addEventListener('click', async () => {
  flashcardsContainer.innerHTML = '';
  errorMessage.textContent = '';
  exportPdfButton.classList.add('hidden');
  generateButton.disabled = true;

  const flashcardSchema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        term: {type: Type.STRING},
        definition: {type: Type.STRING},
        mnemonic: {type: Type.STRING},
      },
      required: ['term', 'definition', 'mnemonic'],
    },
  };
  
  const basePrompt = `Analyze the provided text/document and identify key concepts. For each concept, generate a flashcard with a term, a concise definition, and a clever mnemonic to help with memorization. The language of the flashcard content must match the language of the source material. Format the output as a JSON array of objects.`;

  try {
    let responseText: string | null = null;
    if (currentMode === 'text') {
      loader.classList.remove('hidden');
      const topic = topicInput.value.trim();
      if (!topic) {
        errorMessage.textContent =
          'Please enter a topic or some terms and definitions.';
        return;
      }
      
      const prompt = `${basePrompt}\n\nSource Text:\n"${topic}"`;

      const result = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: flashcardSchema
        }
      });
      responseText = result?.text ?? null;
    } else {
      if (!selectedPdfFile) {
        errorMessage.textContent = 'Please select a PDF file.';
        return;
      }
      
      // Setup for cancellable PDF processing
      abortController = new AbortController();
      cancelButton.classList.remove('hidden');
      generateButton.classList.add('hidden');
      progressContainer.classList.remove('hidden');
      progressBar.style.width = '0%';
      progressText.textContent = '0%';

      const onProgress = (percent: number) => {
        progressBar.style.width = `${percent}%`;
        progressText.textContent = `${percent}%`;
      };

      const pageSelection = pdfPageInput.value;
      const imageParts = await processPdf(selectedPdfFile, pageSelection, onProgress, abortController.signal);

      // PDF processing done, switch to Gemini loader
      progressContainer.classList.add('hidden');
      cancelButton.classList.add('hidden');
      loader.classList.remove('hidden');

      const textPart = { text: basePrompt };
      const result = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: {parts: [textPart, ...imageParts.map((p) => ({inlineData: p}))]},
        config: {
            responseMimeType: "application/json",
            responseSchema: flashcardSchema
        }
      });
      responseText = result?.text ?? null;
    }

    if (responseText) {
      parseAndDisplayResponse(responseText);
    } else {
      errorMessage.textContent =
        'Failed to generate flashcards or received an empty response. Please try again.';
    }
  } catch (error: unknown) {
    console.error('Error generating content:', error);
    if (error instanceof DOMException && error.name === 'AbortError') {
        errorMessage.textContent = 'Processing cancelled.';
    } else {
        const detailedError =
        (error as Error)?.message || 'An unknown error occurred';
        errorMessage.textContent = `An error occurred: ${detailedError}`;
    }
    flashcardsContainer.textContent = '';
  } finally {
    generateButton.disabled = false;
    generateButton.classList.remove('hidden');
    loader.classList.add('hidden');
    progressContainer.classList.add('hidden');
    cancelButton.classList.add('hidden');
    abortController = null;
  }
});

// Initialize with text mode
setMode('text');