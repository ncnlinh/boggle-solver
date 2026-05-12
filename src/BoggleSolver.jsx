import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { RefreshCw, Grid, CheckCircle, HelpCircle, Copy, Clipboard, History, X, Upload, Image as ImageIcon, Settings, Share2 } from 'lucide-react';
import { DICTIONARY, DICTIONARY_ARRAY } from './dictionary_full.js';
import { buildTrie } from './trie.js';
import { createWorker } from 'tesseract.js';

const STORAGE_KEY = 'boggle-historic-boards';
const GEMINI_API_KEY_STORAGE_KEY = 'boggle-gemini-api-key';
const MAX_HISTORY = 50; // Maximum number of historic boards to keep

const BoggleSolver = () => {
  const [gridSize, setGridSize] = useState(4);
  const [grid, setGrid] = useState(Array(16).fill(''));
  const [foundWords, setFoundWords] = useState([]);
  const [hoveredPath, setHoveredPath] = useState(null);
  const [isSolving, setIsSolving] = useState(false);
  const [copied, setCopied] = useState(false);
  // Initialize historic boards from localStorage
  const initializeHistoricBoards = () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return Array.isArray(parsed) ? parsed : [];
      }
    } catch (err) {
      console.error('Failed to load historic boards:', err);
    }
    return [];
  };

  const [historicBoards, setHistoricBoards] = useState(initializeHistoricBoards);
  const [showHistory, setShowHistory] = useState(false);
  const [isHistoryLoaded, setIsHistoryLoaded] = useState(false);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [imagePreview, setImagePreview] = useState(null);
  const [showImageUpload, setShowImageUpload] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const inputRefs = useRef([]);
  const solvingRef = useRef(false);
  const fileInputRef = useRef(null);
  const dropZoneRef = useRef(null);
  const skipGridClearRef = useRef(false);

  // Build Trie once on mount - this is expensive but only done once
  const dictionaryTrie = useMemo(() => {
    return buildTrie(DICTIONARY_ARRAY);
  }, []);

  // Load Gemini API key from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(GEMINI_API_KEY_STORAGE_KEY);
      if (stored) {
        setGeminiApiKey(stored);
      }
    } catch (err) {
      console.error('Failed to load Gemini API key:', err);
    }
  }, []);

  // Save Gemini API key to localStorage when it changes
  useEffect(() => {
    if (geminiApiKey) {
      try {
        localStorage.setItem(GEMINI_API_KEY_STORAGE_KEY, geminiApiKey);
      } catch (err) {
        console.error('Failed to save Gemini API key:', err);
      }
    } else {
      try {
        localStorage.removeItem(GEMINI_API_KEY_STORAGE_KEY);
      } catch (err) {
        console.error('Failed to remove Gemini API key:', err);
      }
    }
  }, [geminiApiKey]);

  // Mark history as loaded after initial render
  useEffect(() => {
    setIsHistoryLoaded(true);
  }, []);

  // Save historic boards to localStorage whenever it changes (but only after initial load)
  useEffect(() => {
    if (isHistoryLoaded) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(historicBoards));
      } catch (err) {
        console.error('Failed to save historic boards:', err);
        // Handle quota exceeded error gracefully
        if (err.name === 'QuotaExceededError') {
          console.warn('LocalStorage quota exceeded. Keeping only most recent boards.');
          // Keep only the most recent 25 boards if quota is exceeded
          const reduced = historicBoards.slice(0, 25);
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(reduced));
            setHistoricBoards(reduced);
          } catch (e) {
            console.error('Failed to save reduced history:', e);
          }
        }
      }
    }
  }, [historicBoards, isHistoryLoaded]);

  // Adjust grid array when size changes
  useEffect(() => {
    if (skipGridClearRef.current) {
      skipGridClearRef.current = false;
      return;
    }
    setGrid(Array(gridSize * gridSize).fill(''));
    setFoundWords([]);
    setHoveredPath(null);
    inputRefs.current = inputRefs.current.slice(0, gridSize * gridSize);
  }, [gridSize]);

  // Encode the board as a string: letters in order from 1,1 to NxN. Q stored as Q (treated as QU only when solving).
  const boardCode = useMemo(() => {
    return grid.map(cell => cell || '').join('');
  }, [grid]);

  // Handle individual cell input
  const handleInputChange = (index, value) => {
    const newGrid = [...grid];
    const upperValue = value.toUpperCase();

    // Take the last character typed (single letter per cell, Q stays as Q)
    const lastChar = upperValue.slice(-1);
    if (lastChar && /[A-Z]/.test(lastChar)) {
      newGrid[index] = lastChar;
    } else {
      newGrid[index] = '';
    }

    setGrid(newGrid);

    // Auto-focus next cell and select its content
    if (newGrid[index] && index < grid.length - 1) {
      const nextInput = inputRefs.current[index + 1];
      nextInput?.focus();
      nextInput?.select();
    }
  };

  const focusAndSelect = (inputEl) => {
    inputEl?.focus();
    inputEl?.select();
  };

  const handleKeyDown = (e, index) => {
    if (e.key === 'Backspace' && !grid[index] && index > 0) {
      e.preventDefault();
      inputRefs.current[index - 1]?.focus();
    }
    if (e.key === 'Enter' && index === grid.length - 1 && grid[index]) {
      e.preventDefault();
      solveGrid();
    }
    // Arrow key navigation
    if (e.key === 'ArrowRight' && index < grid.length - 1) focusAndSelect(inputRefs.current[index + 1]);
    if (e.key === 'ArrowLeft' && index > 0) focusAndSelect(inputRefs.current[index - 1]);
    if (e.key === 'ArrowDown' && index + gridSize < grid.length) focusAndSelect(inputRefs.current[index + gridSize]);
    if (e.key === 'ArrowUp' && index - gridSize >= 0) focusAndSelect(inputRefs.current[index - gridSize]);
  };

  // Auto-save current board to history (internal function)
  const autoSaveBoardToHistory = useCallback((gridToSave, gridSizeToSave, foundWordsToSave) => {
    // Check if grid has any content
    const hasContent = gridToSave.some(cell => cell.trim() !== '');
    if (!hasContent) {
      return false;
    }

    // Create a signature to check for duplicates (same grid content)
    const gridSignature = gridToSave.join('');

    setHistoricBoards(prev => {
      // Check if this exact board was already saved recently (within last 5 seconds)
      const now = Date.now();
      const recentDuplicate = prev.find(board => {
        const boardTime = new Date(board.timestamp).getTime();
        const timeDiff = now - boardTime;
        return board.grid.join('') === gridSignature && timeDiff < 5000;
      });

      // Skip if it's a duplicate saved very recently
      if (recentDuplicate) {
        return prev;
      }

      const boardData = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        gridSize: gridSizeToSave,
        grid: [...gridToSave],
        foundWords: [...foundWordsToSave],
        wordCount: foundWordsToSave.length
      };

      const updated = [boardData, ...prev];
      // Keep only the most recent MAX_HISTORY boards
      return updated.slice(0, MAX_HISTORY);
    });

    return true;
  }, []);

  // --- SOLVER LOGIC ---
  const getNeighbors = (index, size) => {
    const row = Math.floor(index / size);
    const col = index % size;
    const neighbors = [];

    for (let r = row - 1; r <= row + 1; r++) {
      for (let c = col - 1; c <= col + 1; c++) {
        if (r >= 0 && r < size && c >= 0 && c < size && !(r === row && c === col)) {
          neighbors.push(r * size + c);
        }
      }
    }
    return neighbors;
  };

  const solveGrid = async () => {
    setIsSolving(true);
    setFoundWords([]);
    solvingRef.current = true;
    
    const results = [];
    const foundWordsSet = new Set(); // Track found words to avoid duplicates
    let processedPaths = 0;
    
    // Adaptive batching based on grid size - smaller batches for larger grids
    const BATCH_SIZE = gridSize === 6 ? 500 : gridSize === 5 ? 1000 : 2000;
    const UPDATE_INTERVAL = gridSize === 6 ? 5 : gridSize === 5 ? 10 : 20; // Update UI more frequently for larger grids
    
    // Use scheduler.postTask if available (better performance), otherwise setTimeout
    const yieldToUI = () => {
      if (typeof scheduler !== 'undefined' && scheduler.postTask) {
        return scheduler.postTask(() => {}, { priority: 'user-blocking' });
      }
      return new Promise(resolve => setTimeout(resolve, 0));
    };

    // Async DFS with early pruning using Trie
    const dfs = async (cellIndex, currentWord, path, visited) => {
      if (!solvingRef.current) return; // Stop if cancelled

      // Check if current word is valid (min 3 chars) and in dictionary
      if (currentWord.length >= 3 && dictionaryTrie.has(currentWord) && !foundWordsSet.has(currentWord)) {
        foundWordsSet.add(currentWord);
        results.push({ word: currentWord, path: [...path] });
        
        // Update UI incrementally - show words as they're found (more frequent for larger grids)
        if (results.length % UPDATE_INTERVAL === 0) {
          // Sort and update UI
          const sorted = [...results].sort((a, b) => 
            b.word.length - a.word.length || a.word.localeCompare(b.word)
          );
          setFoundWords(sorted);
          await yieldToUI(); // Yield to browser for UI updates
        }
      }

      // Stop exploring if word is too long (most Boggle words are < 17 chars)
      // For 6x6, we can allow slightly longer words
      const maxLength = gridSize === 6 ? 20 : 17;
      if (currentWord.length >= maxLength) return;

      // Early pruning: check if prefix exists in Trie
      // This is the key optimization - we skip paths that can't form valid words
      // Skip prefix check for single characters (they're almost always valid)
      if (currentWord.length >= 2 && !dictionaryTrie.hasPrefix(currentWord)) {
        return; // No words start with this prefix, stop exploring
      }

      // Explore neighbors
      const neighbors = getNeighbors(cellIndex, gridSize);
      for (const neighbor of neighbors) {
        if (!solvingRef.current) return; // Stop if cancelled

        if (!visited.has(neighbor) && grid[neighbor]) {
          // Treat Q as QU when solving
          const cellLetter = grid[neighbor] === 'Q' ? 'QU' : grid[neighbor];
          const nextWord = currentWord + cellLetter;
          
          // Early check: can this prefix be extended?
          if (!dictionaryTrie.hasPrefix(nextWord)) {
            continue; // Skip this neighbor, no valid words start with this prefix
          }
          
          visited.add(neighbor);
          processedPaths++;
          
          // Yield periodically to keep UI responsive (more frequent for larger grids)
          if (processedPaths % BATCH_SIZE === 0) {
            await yieldToUI();
          }
          
          await dfs(neighbor, nextWord, [...path, neighbor], visited);
          visited.delete(neighbor);
        }
      }
    };

    // Start DFS from each cell in the grid
    for (let i = 0; i < grid.length; i++) {
      if (!solvingRef.current) break; // Stop if cancelled

      if (grid[i]) { // Only start from non-empty cells
        const visited = new Set([i]);
        // Treat Q as QU when solving
        const startLetter = grid[i] === 'Q' ? 'QU' : grid[i];
        await dfs(i, startLetter, [i], visited);
      }
    }

    if (solvingRef.current) {
      // Final sort by length (descending) then alphabetical
      results.sort((a, b) => b.word.length - a.word.length || a.word.localeCompare(b.word));
      setFoundWords(results);
      
      // Auto-save board to history when solving completes successfully
      autoSaveBoardToHistory(grid, gridSize, results);
    }
    
    setIsSolving(false);
    solvingRef.current = false;
  };

  // Restore a board from history
  const restoreBoard = useCallback((boardData) => {
    skipGridClearRef.current = true;
    setGridSize(boardData.gridSize);
    setGrid(boardData.grid);
    setFoundWords(boardData.foundWords || []);
    setHoveredPath(null);
    setShowHistory(false);
    // Focus first input after a brief delay to allow state updates
    setTimeout(() => {
      inputRefs.current[0]?.focus();
    }, 100);
  }, []);

  // Delete a board from history
  const deleteBoardFromHistory = useCallback((id) => {
    setHistoricBoards(prev => prev.filter(board => board.id !== id));
  }, []);

  const clearGrid = () => {
    solvingRef.current = false; // Cancel any ongoing solving
    setGrid(Array(gridSize * gridSize).fill(''));
    setFoundWords([]);
    setHoveredPath(null);
    setIsSolving(false);
    inputRefs.current[0]?.focus();
  };

  // Load a board from a board code string (continuous letters)
  const loadBoardCode = useCallback((code) => {
    const letters = code.toUpperCase().replace(/[^A-Z]/g, '').split('');
    if (letters.length < 16) return false;

    let inferredSize = 4;
    if (letters.length >= 36) inferredSize = 6;
    else if (letters.length >= 25) inferredSize = 5;

    skipGridClearRef.current = true;
    setGridSize(inferredSize);
    const newGrid = Array(inferredSize * inferredSize).fill('');
    for (let i = 0; i < Math.min(letters.length, inferredSize * inferredSize); i++) {
      newGrid[i] = letters[i];
    }
    setGrid(newGrid);
    setFoundWords([]);
    setHoveredPath(null);
    inputRefs.current[0]?.focus();
    return true;
  }, []);

  // Decode board from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const boardParam = params.get('board');
    if (boardParam) {
      loadBoardCode(boardParam);
    }
  }, [loadBoardCode]);

  // Sync board state to the URL as tiles change
  useEffect(() => {
    const url = new URL(window.location.href);
    if (boardCode) {
      url.searchParams.set('board', boardCode);
    } else {
      url.searchParams.delete('board');
    }
    window.history.replaceState(null, '', url);
  }, [boardCode]);

  // Build a shareable URL with the current board encoded as a query param
  const shareUrl = useMemo(() => {
    if (!boardCode) return '';
    const url = new URL(window.location.href.split('?')[0]);
    url.searchParams.set('board', boardCode);
    return url.toString();
  }, [boardCode]);

  // Copy share URL to clipboard
  const [shareCopied, setShareCopied] = useState(false);
  const handleShare = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy share URL:', err);
    }
  };

  // Parse pasted text into grid
  const handlePaste = useCallback((e) => {
    e.preventDefault();
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';

    if (!text) return;

    const trimmed = text.trim();

    // If the pasted text is a single line of only letters (board code), load it directly
    if (/^[A-Za-z]+$/.test(trimmed) && trimmed.length >= 16) {
      loadBoardCode(trimmed);
      return;
    }

    // Parse the text: split by newlines, then by tabs or spaces
    const lines = trimmed.split(/\r?\n/).filter(line => line.trim());
    const parsedGrid = [];

    for (const line of lines) {
      let cells;
      if (line.includes('\t')) {
        cells = line.split('\t').filter(cell => cell.trim());
      } else if (line.match(/\s{2,}/)) {
        cells = line.split(/\s{2,}/).filter(cell => cell.trim());
      } else {
        cells = line.split(/\s+/).filter(cell => cell.trim());
      }
      parsedGrid.push(...cells.map(cell => {
        const trimmed = cell.trim().toUpperCase();
        // Take first character only (Q stays as Q, treated as QU when solving)
        return trimmed.slice(0, 1);
      }));
    }

    if (parsedGrid.length === 0) return;

    // Calculate number of columns from first line to determine grid size
    const firstLineCells = lines[0].includes('\t')
      ? lines[0].split('\t').filter(c => c.trim())
      : lines[0].match(/\s{2,}/)
        ? lines[0].split(/\s{2,}/).filter(c => c.trim())
        : lines[0].split(/\s+/).filter(c => c.trim());
    const numCols = firstLineCells.length;
    const numRows = lines.length;

    // If we have a square grid, use that size
    if (numRows === numCols && numRows >= 4 && numRows <= 6) {
      skipGridClearRef.current = true;
      setGridSize(numRows);
      const newGrid = Array(numRows * numRows).fill('');
      for (let i = 0; i < Math.min(parsedGrid.length, numRows * numRows); i++) {
        newGrid[i] = parsedGrid[i] || '';
      }
      setGrid(newGrid);
      inputRefs.current[0]?.focus();
    } else if (parsedGrid.length >= gridSize * gridSize) {
      const newGrid = Array(gridSize * gridSize).fill('');
      for (let i = 0; i < Math.min(parsedGrid.length, gridSize * gridSize); i++) {
        newGrid[i] = parsedGrid[i] || '';
      }
      setGrid(newGrid);
      inputRefs.current[0]?.focus();
    } else if (parsedGrid.length > 0) {
      const inferredSize = Math.ceil(Math.sqrt(parsedGrid.length));
      if (inferredSize >= 4 && inferredSize <= 6) {
        skipGridClearRef.current = true;
        setGridSize(inferredSize);
        const newGrid = Array(inferredSize * inferredSize).fill('');
        for (let i = 0; i < Math.min(parsedGrid.length, inferredSize * inferredSize); i++) {
          newGrid[i] = parsedGrid[i] || '';
        }
        setGrid(newGrid);
        inputRefs.current[0]?.focus();
      }
    }
  }, [gridSize, loadBoardCode]);

  // Global paste handler
  useEffect(() => {
    const handleGlobalPaste = (e) => {
      // Only handle if not typing in an input
      if (e.target.tagName !== 'INPUT') {
        handlePaste(e);
      }
    };

    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, [handlePaste]);

  // Get gradient color from dark red to light yellow based on position in path
  const getRainbowColor = (index, totalLength) => {
    // Gradient from dark red (hsl(0, 100%, 35%)) to yellow (hsl(60, 100%, 50%))
    const progress = index / Math.max(totalLength - 1, 1);
    const hue = progress * 0 + (progress * 60); // Interpolate from 0 (red) to 60 (yellow)
    const saturation = 100 - (progress * 20); // Keep saturation high for vibrant colors
    const lightness = 35 + (progress * 5); // Interpolate from 35% (dark) to 70% (lighter but readable)
    
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  };

  // Copy grid to clipboard in the same format
  const copyGrid = async () => {
    const rows = [];
    for (let i = 0; i < gridSize; i++) {
      const row = [];
      for (let j = 0; j < gridSize; j++) {
        const index = i * gridSize + j;
        row.push(grid[index] || '');
      }
      rows.push(row.join('\t'));
    }
    const text = rows.join('\n');
    
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Handle paste button click
  const handlePasteButton = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        // Create a synthetic paste event
        const syntheticEvent = {
          preventDefault: () => {},
          clipboardData: {
            getData: () => text
          }
        };
        handlePaste(syntheticEvent);
      }
    } catch (err) {
      console.error('Failed to read clipboard:', err);
      // Fallback: prompt user to paste manually
      alert('Please paste the grid text directly into the grid area (click on the grid and press Ctrl+V / Cmd+V)');
    }
  };

  // Process image with Gemini API
  const processImageWithGemini = async (file) => {
    if (!geminiApiKey) {
      throw new Error('Gemini API key not configured');
    }

    // Convert file to base64
    const base64Image = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1]; // Remove data:image/...;base64, prefix
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    // Determine MIME type
    const mimeType = file.type || 'image/png';

    // Call Gemini API
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent?key=${geminiApiKey}`;
    
    const prompt = `You are analyzing a screenshot of a Boggle game board. The board contains a grid of letters (typically 4x4, 5x5, or 6x6). Some cells may contain "Qu" which represents the letter Q.

Please extract all the letters from the grid and return them in a format that can be parsed. Return ONLY the letters in row-major order (left to right, top to bottom), separated by spaces or newlines. For example, if you see a 4x4 grid:
A B C D
E F G H
I J K L
M N O P

Return: A B C D E F G H I J K L M N O P

If you see "Qu" or "QU", return it as "QU".

Return ONLY the letters, nothing else. No explanations, no additional text.`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              text: prompt
            },
            {
              inline_data: {
                mime_type: mimeType,
                data: base64Image
              }
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    const extractedText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    if (!extractedText) {
      throw new Error('No text extracted from image');
    }

    // Parse the extracted text
    const letters = extractedText
      .toUpperCase()
      .replace(/[^A-Z\s]/g, '') // Remove non-letter characters except spaces
      .split(/\s+/)
      .filter(letter => letter.length > 0)
      .map(letter => {
        // Take first character only (Q stays as Q, treated as QU when solving)
        return letter.slice(0, 1);
      });

    return letters;
  };

  // Process screenshot with OCR or Gemini
  const processScreenshot = async (file) => {
    if (!file) return;

    setIsProcessingImage(true);
    const previewUrl = URL.createObjectURL(file);
    setImagePreview(previewUrl);

    // Try Gemini first if API key is available
    if (geminiApiKey) {
      try {
        const letters = await processImageWithGemini(file);
        
        if (letters.length >= 16) {
          // Infer grid size
          let inferredSize = 4;
          if (letters.length >= 36) inferredSize = 6;
          else if (letters.length >= 25) inferredSize = 5;

          skipGridClearRef.current = true;
          setGridSize(inferredSize);
          const newGrid = Array(inferredSize * inferredSize).fill('');
          for (let i = 0; i < Math.min(letters.length, inferredSize * inferredSize); i++) {
            newGrid[i] = letters[i];
          }
          setGrid(newGrid);
          setShowImageUpload(false);
          URL.revokeObjectURL(previewUrl);
          setImagePreview(null);
          setIsProcessingImage(false);
          inputRefs.current[0]?.focus();
          return;
        } else {
          console.warn(`Gemini extracted only ${letters.length} letters, falling back to OCR`);
        }
      } catch (error) {
        console.error('Gemini API error:', error);
        // Fall through to OCR fallback
      }
    }

    // Fallback to OCR if Gemini fails or is not configured
    let worker = null;
    try {
      // Use Tesseract.js to perform OCR
      worker = await createWorker('eng');
      const { data: { text, words } } = await worker.recognize(file);
      await worker.terminate();
      worker = null;

      console.log('OCR Text:', text);
      console.log('OCR Words:', words);

      // Parse OCR results to extract grid
      // Strategy: Look for patterns that match a grid layout
      // The OCR might return text in various formats, so we need to be flexible
      
      const letterPattern = /^[A-Z]{1,2}$/i;
      
      // First, try to extract from words array (more structured, includes position info)
      // Sort words by their position (top to bottom, left to right)
      const sortedWords = [...words]
        .filter(word => {
          const text = word.text.trim().toUpperCase();
          // Match single letters or "QU"
          return letterPattern.test(text) && (text.length === 1 || text === 'QU' || text === 'Q');
        })
        .sort((a, b) => {
          // Sort by Y position first (top to bottom), then X position (left to right)
          const yDiff = a.bbox.y0 - b.bbox.y0;
          if (Math.abs(yDiff) > 10) return yDiff; // Different row
          return a.bbox.x0 - b.bbox.x0; // Same row, sort by X
        })
        .map(word => {
          const text = word.text.trim().toUpperCase();
          // Take first character only (Q stays as Q)
          return text.slice(0, 1);
        });

      // If we got enough letters from structured data, use them
      if (sortedWords.length >= 16) {
        // Try to infer grid size
        let inferredSize = 4;
        if (sortedWords.length >= 36) inferredSize = 6;
        else if (sortedWords.length >= 25) inferredSize = 5;

        skipGridClearRef.current = true;
        setGridSize(inferredSize);
        const newGrid = Array(inferredSize * inferredSize).fill('');
        for (let i = 0; i < Math.min(sortedWords.length, inferredSize * inferredSize); i++) {
          newGrid[i] = sortedWords[i];
        }
        setGrid(newGrid);
        setShowImageUpload(false);
        URL.revokeObjectURL(previewUrl);
        setImagePreview(null);
        setIsProcessingImage(false);
        inputRefs.current[0]?.focus();
        return;
      }

      // Fallback: Parse from raw text
      // Try to extract letters from the text, handling various formats
      const lines = text.split(/\r?\n/).filter(line => line.trim());
      const allLetters = [];
      
      // Helper function to extract letters from a token, handling OCR errors
      const extractLetters = (token) => {
        const cleaned = token.trim().toUpperCase().replace(/[^A-Z]/g, '');
        if (!cleaned) return [];

        const letters = [];

        if (cleaned.length === 1) {
          letters.push(cleaned);
        } else {
          // Multiple letters - extract them, but be smart about OCR errors
          let filtered = cleaned;

          // Special case: "JI" is likely a misread "I"
          if (filtered === 'JI') {
            letters.push('I');
            return letters;
          }

          // Remove sequences of 3+ consecutive I's (likely OCR artifacts)
          filtered = filtered.replace(/I{3,}/g, '');

          // Remove leading I's if followed by other letters (like "ITIU" -> "TIU")
          filtered = filtered.replace(/^I+([A-Z])/g, '$1');

          // Remove I's that appear between other letters (common OCR error)
          for (let i = 0; i < 5; i++) {
            filtered = filtered.replace(/([A-Z])I([A-Z])/g, '$1$2');
          }

          // Handle double/triple I's - keep only one if it's at the end
          filtered = filtered.replace(/([A-Z])II+$/g, '$1I');

          // Handle standalone II sequences - keep one
          filtered = filtered.replace(/^II+$/g, 'I');

          // Now extract individual letters (Q stays as Q)
          for (const char of filtered) {
            if (/[A-Z]/.test(char)) {
              letters.push(char);
            }
          }
        }

        return letters;
      };
      
      // Parse each line
      for (const line of lines) {
        // Split by pipe characters first (common OCR separator)
        const segments = line.split(/\|/).map(s => s.trim()).filter(s => s);
        
        if (segments.length > 0) {
          // If we have pipe-separated segments, process each
          for (const segment of segments) {
            // Also split by whitespace in case there are multiple tokens
            const tokens = segment.split(/\s+/).filter(t => t.trim());
            for (const token of tokens) {
              const extracted = extractLetters(token);
              allLetters.push(...extracted);
            }
          }
        } else {
          // No pipes, try splitting by whitespace
          const tokens = line.trim().split(/\s+/).filter(t => t.trim());
          for (const token of tokens) {
            const extracted = extractLetters(token);
            allLetters.push(...extracted);
          }
        }
      }
      
      // Post-process: remove excessive I's that are likely OCR artifacts
      // If we have too many I's relative to other letters, remove some
      const iCount = allLetters.filter(l => l === 'I').length;
      const otherCount = allLetters.filter(l => l !== 'I').length;
      
      // If I's are more than 30% of total and we have many letters, filter some out
      if (iCount > 0 && allLetters.length > 20 && iCount / allLetters.length > 0.3) {
        const filtered = [];
        let iStreak = 0;
        for (let i = 0; i < allLetters.length; i++) {
          if (allLetters[i] === 'I') {
            iStreak++;
            // Only keep every other I in long streaks, or if streak is short
            if (iStreak <= 2 || iStreak % 2 === 1) {
              filtered.push('I');
            }
          } else {
            iStreak = 0;
            filtered.push(allLetters[i]);
          }
        }
        allLetters.length = 0;
        allLetters.push(...filtered);
      }
      
      // Final cleanup: if we have way too many letters, try to extract a grid pattern
      // For a 6x6 grid, we should have exactly 36 letters
      if (allLetters.length > 36) {
        // Try to take first 36 letters, or sample evenly
        const sampled = [];
        const step = Math.floor(allLetters.length / 36);
        for (let i = 0; i < 36 && i * step < allLetters.length; i++) {
          sampled.push(allLetters[i * step]);
        }
        if (sampled.length >= 16) {
          allLetters.length = 0;
          allLetters.push(...sampled);
        }
      }

      // Also try extracting from words array without position sorting (fallback)
      if (allLetters.length < 16) {
        const wordsLetters = words
          .map(word => {
            const text = word.text.trim().toUpperCase().replace(/[^A-Z]/g, '');
            if (text.length === 1) return text;
            if (text === 'QU' || text === 'Q') return 'Q';
            if (text.length === 2 && text.startsWith('Q')) return 'Q';
            return null;
          })
          .filter(Boolean);
        
        if (wordsLetters.length > allLetters.length) {
          allLetters.length = 0;
          allLetters.push(...wordsLetters);
        }
      }

      // If we have enough letters, populate the grid
      if (allLetters.length >= 16) {
        let inferredSize = 4;
        if (allLetters.length >= 36) inferredSize = 6;
        else if (allLetters.length >= 25) inferredSize = 5;

        skipGridClearRef.current = true;
        setGridSize(inferredSize);
        const newGrid = Array(inferredSize * inferredSize).fill('');
        for (let i = 0; i < Math.min(allLetters.length, inferredSize * inferredSize); i++) {
          newGrid[i] = allLetters[i];
        }
        setGrid(newGrid);
        setShowImageUpload(false);
        URL.revokeObjectURL(previewUrl);
        setImagePreview(null);
        setIsProcessingImage(false);
        inputRefs.current[0]?.focus();
      } else {
        URL.revokeObjectURL(previewUrl);
        alert(`Could not extract enough letters from the image. Found ${allLetters.length} letters. Please try a clearer image with better contrast, or manually enter the grid.`);
        setIsProcessingImage(false);
        setImagePreview(null);
      }
    } catch (error) {
      console.error('OCR Error:', error);
      if (worker) {
        try {
          await worker.terminate();
        } catch (e) {
          console.error('Error terminating worker:', e);
        }
      }
      URL.revokeObjectURL(previewUrl);
      alert('Failed to process image. Please try again or enter the grid manually.');
      setIsProcessingImage(false);
      setImagePreview(null);
    }
  };

  // Handle file input change
  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('image/')) {
      processScreenshot(file);
    }
  };

  // Handle drag and drop
  const handleDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      processScreenshot(file);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  // Handle drag and drop zone
  useEffect(() => {
    const dropZone = dropZoneRef.current;
    if (!dropZone) return;

    const handleDropWrapper = (e) => handleDrop(e);
    const handleDragOverWrapper = (e) => handleDragOver(e);

    dropZone.addEventListener('drop', handleDropWrapper);
    dropZone.addEventListener('dragover', handleDragOverWrapper);

    return () => {
      dropZone.removeEventListener('drop', handleDropWrapper);
      dropZone.removeEventListener('dragover', handleDragOverWrapper);
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100">
      <div className="max-w-6xl mx-auto p-4 md:p-8">
        
        {/* Header */}
        <header className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-extrabold text-indigo-600 flex items-center gap-2">
              <Grid className="w-8 h-8" />
              Boggle Party Solver
            </h1>
            <p className="text-slate-500 mt-1">Enter your grid, edit the dictionary, and find words instantly.</p>
          </div>
          
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 bg-white p-1 rounded-lg border border-slate-200 shadow-sm">
              {[4, 5, 6].map(size => (
                <button
                  key={size}
                  onClick={() => setGridSize(size)}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                    gridSize === size 
                      ? 'bg-indigo-600 text-white shadow-md' 
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {size}x{size}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition-colors shadow-sm"
              title="Settings"
            >
              <Settings className="w-5 h-5 text-slate-600" />
            </button>
          </div>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* LEFT COLUMN: Grid Input */}
          <section className="lg:col-span-7 flex flex-col gap-6">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold text-slate-800">Grid Input</h2>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setShowImageUpload(!showImageUpload)}
                    className="text-sm text-slate-500 hover:text-indigo-600 flex items-center gap-1 transition-colors px-2 py-1 rounded hover:bg-slate-50"
                    title="Upload screenshot to extract grid"
                  >
                    <ImageIcon className="w-4 h-4" /> Screenshot
                  </button>
                  <button 
                    onClick={() => setShowHistory(!showHistory)}
                    className="text-sm text-slate-500 hover:text-indigo-600 flex items-center gap-1 transition-colors px-2 py-1 rounded hover:bg-slate-50"
                    title="View historic boards"
                  >
                    <History className="w-4 h-4" /> History
                    {historicBoards.length > 0 && (
                      <span className="bg-indigo-100 text-indigo-700 text-xs px-1.5 py-0.5 rounded-full">
                        {historicBoards.length}
                      </span>
                    )}
                  </button>
                  <button 
                    onClick={copyGrid}
                    className="text-sm text-slate-500 hover:text-indigo-600 flex items-center gap-1 transition-colors px-2 py-1 rounded hover:bg-slate-50"
                    title="Copy grid to clipboard"
                  >
                    <Copy className={`w-4 h-4 ${copied ? 'text-green-600' : ''}`} /> 
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                  <button 
                    onClick={handlePasteButton}
                    className="text-sm text-slate-500 hover:text-indigo-600 flex items-center gap-1 transition-colors px-2 py-1 rounded hover:bg-slate-50"
                    title="Paste grid from clipboard"
                  >
                    <Clipboard className="w-4 h-4" /> Paste
                  </button>
                  <button
                    onClick={clearGrid}
                    className="text-sm text-slate-500 hover:text-red-500 flex items-center gap-1 transition-colors px-2 py-1 rounded hover:bg-slate-50"
                  >
                    <RefreshCw className="w-4 h-4" /> Clear
                  </button>
                  <button
                    onClick={handleShare}
                    disabled={!boardCode}
                    className="text-sm text-slate-500 hover:text-indigo-600 flex items-center gap-1 transition-colors px-2 py-1 rounded hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Copy shareable link"
                  >
                    <Share2 className={`w-4 h-4 ${shareCopied ? 'text-green-600' : ''}`} />
                    {shareCopied ? 'Link copied!' : 'Share'}
                  </button>
                </div>
              </div>

              {/* Settings Panel */}
              {showSettings && (
                <div className="mb-6 border-t border-slate-200 pt-6">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-md font-semibold text-slate-800 flex items-center gap-2">
                      <Settings className="w-5 h-5" />
                      Settings
                    </h3>
                    <button
                      onClick={() => setShowSettings(false)}
                      className="text-slate-400 hover:text-slate-600 transition-colors"
                      title="Close settings"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  
                  <div className="space-y-4">
                    <div>
                      <label htmlFor="gemini-api-key" className="block text-sm font-medium text-slate-700 mb-2">
                        Gemini API Key
                      </label>
                      <input
                        id="gemini-api-key"
                        type="password"
                        value={geminiApiKey}
                        onChange={(e) => setGeminiApiKey(e.target.value)}
                        placeholder="Enter your Gemini API key"
                        className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                      />
                      <p className="text-xs text-slate-500 mt-1">
                        Get your API key from{' '}
                        <a 
                          href="https://aistudio.google.com/app/apikey" 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-indigo-600 hover:underline"
                        >
                          Google AI Studio
                        </a>
                        . Used for improved screenshot processing with Gemini 3 Flash.
                      </p>
                      {geminiApiKey && (
                        <button
                          onClick={() => setGeminiApiKey('')}
                          className="mt-2 text-xs text-red-600 hover:text-red-700"
                        >
                          Clear API key
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Image Upload Panel */}
              {showImageUpload && (
                <div className="mb-6 border-t border-slate-200 pt-6">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-md font-semibold text-slate-800 flex items-center gap-2">
                      <ImageIcon className="w-5 h-5" />
                      Process Screenshot
                      {geminiApiKey && (
                        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                          Using Gemini
                        </span>
                      )}
                    </h3>
                    <button
                      onClick={() => {
                        setShowImageUpload(false);
                        if (imagePreview) {
                          URL.revokeObjectURL(imagePreview);
                        }
                        setImagePreview(null);
                        if (fileInputRef.current) fileInputRef.current.value = '';
                      }}
                      className="text-slate-400 hover:text-slate-600 transition-colors"
                      title="Close image upload"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  
                  <div
                    ref={dropZoneRef}
                    className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center hover:border-indigo-400 transition-colors bg-slate-50"
                  >
                    {isProcessingImage ? (
                      <div className="flex flex-col items-center gap-4">
                        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
                        <p className="text-slate-600">
                          {geminiApiKey ? 'Processing image with Gemini AI...' : 'Processing image with OCR...'}
                        </p>
                        <p className="text-sm text-slate-400">This may take a few seconds</p>
                      </div>
                    ) : imagePreview ? (
                      <div className="flex flex-col items-center gap-4">
                        <img 
                          src={imagePreview} 
                          alt="Preview" 
                          className="max-w-full max-h-64 rounded-lg shadow-md"
                        />
                        <button
                          onClick={() => {
                            if (imagePreview) {
                              URL.revokeObjectURL(imagePreview);
                            }
                            setImagePreview(null);
                            if (fileInputRef.current) fileInputRef.current.value = '';
                          }}
                          className="text-sm text-slate-500 hover:text-red-500"
                        >
                          Remove image
                        </button>
                      </div>
                    ) : (
                      <>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/*"
                          onChange={handleFileChange}
                          className="hidden"
                          id="image-upload"
                        />
                        <label
                          htmlFor="image-upload"
                          className="cursor-pointer flex flex-col items-center gap-4"
                        >
                          <Upload className="w-12 h-12 text-slate-400" />
                          <div>
                            <p className="text-slate-700 font-medium">
                              Drop an image here or click to upload
                            </p>
                            <p className="text-sm text-slate-500 mt-1">
                              Supports PNG, JPG, and other image formats
                            </p>
                          </div>
                        </label>
                      </>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-3 text-center">
                    {geminiApiKey 
                      ? 'Gemini AI will extract letters from your screenshot. For best results, use a clear image with good contrast.'
                      : 'OCR will attempt to extract letters from your screenshot. For best results, use a clear image with good contrast. Configure Gemini API key in Settings for improved accuracy.'
                    }
                  </p>
                </div>
              )}

              {/* THE GRID */}
              <div 
                className="grid gap-3 mx-auto transition-all duration-300"
                style={{
                  gridTemplateColumns: `repeat(${gridSize}, minmax(0, 1fr))`,
                  maxWidth: gridSize === 4 ? '400px' : gridSize === 5 ? '500px' : '600px'
                }}
              >
                {grid.map((cell, idx) => {
                  // Determine if this cell is part of the hovered path
                  const pathIndex = hoveredPath ? hoveredPath.indexOf(idx) : -1;
                  const isHighlighted = pathIndex !== -1;
                  const rainbowColor = isHighlighted && hoveredPath 
                    ? getRainbowColor(pathIndex, hoveredPath.length)
                    : null;

                  return (
                    <div key={idx} className="relative aspect-square">
                      <input
                        ref={el => inputRefs.current[idx] = el}
                        type="text"
                        value={cell}
                        onChange={(e) => handleInputChange(idx, e.target.value)}
                        onKeyDown={(e) => handleKeyDown(e, idx)}
                        maxLength={1}
                        className={`w-full h-full text-center font-bold rounded-xl border-2 uppercase outline-none transition-all duration-200
                          text-2xl md:text-3xl
                          ${isHighlighted
                            ? 'scale-105 z-10 shadow-lg'
                            : 'border-slate-200 bg-slate-50 text-slate-800 focus:border-indigo-400 focus:bg-white'
                          }
                          ${cell === 'Q' ? 'text-transparent caret-slate-800' : (isHighlighted ? 'text-slate-900' : '')}
                        `}
                        style={isHighlighted ? {
                          backgroundColor: rainbowColor,
                          borderColor: rainbowColor
                        } : {}}
                      />
                      {/* "Qu" overlay for Q tiles */}
                      {cell === 'Q' && (
                        <div className="absolute inset-0 flex items-center justify-center select-none pointer-events-none">
                          <span className={`text-2xl md:text-3xl font-bold ${isHighlighted ? 'text-slate-900' : 'text-slate-800'}`}>
                            Q<span className="lowercase">u</span>
                          </span>
                        </div>
                      )}
                      {/* Sequence Number Overlay */}
                      {isHighlighted && (
                        <div
                          className="absolute top-1 left-1 md:top-2 md:left-2 w-5 h-5 md:w-6 md:h-6 text-white text-xs md:text-sm font-bold rounded-full flex items-center justify-center animate-in fade-in zoom-in duration-200"
                          style={{ backgroundColor: rainbowColor }}
                        >
                          {pathIndex + 1}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Board Code */}
              {boardCode && (
                <div className="mt-4 text-center">
                  <span className="text-xs text-slate-400 mr-2">Board code:</span>
                  <code className="text-sm font-mono text-slate-600 bg-slate-100 px-2 py-1 rounded select-all">{boardCode}</code>
                </div>
              )}

              <div className="mt-4 flex justify-center">
                <button
                  onClick={solveGrid}
                  disabled={isSolving}
                  className="flex items-center gap-2 px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-full shadow-lg shadow-indigo-200 transition-transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSolving ? 'Solving...' : 'Find Words'}
                  {!isSolving && <CheckCircle className="w-5 h-5" />}
                </button>
              </div>

              {/* Historic Boards Panel */}
              {showHistory && (
                <div className="mt-6 border-t border-slate-200 pt-6">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-md font-semibold text-slate-800 flex items-center gap-2">
                      <History className="w-5 h-5" />
                      Historic Boards
                    </h3>
                    <button
                      onClick={() => setShowHistory(false)}
                      className="text-slate-400 hover:text-slate-600 transition-colors"
                      title="Close history"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  
                  {historicBoards.length === 0 ? (
                    <div className="text-center py-8 text-slate-400 border-2 border-dashed border-slate-100 rounded-xl">
                      <History className="w-8 h-8 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No historic boards yet. Boards are automatically saved when you solve them.</p>
                    </div>
                  ) : (
                    <div className="max-h-96 overflow-y-auto custom-scrollbar space-y-2">
                      {historicBoards.map((board) => {
                        const date = new Date(board.timestamp);
                        const dateStr = date.toLocaleDateString();
                        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        
                        // Create a preview of the grid (first few cells)
                        const previewCells = board.grid.slice(0, 4).filter(c => c).join('').toUpperCase();
                        const preview = previewCells.length > 0 ? previewCells : 'Empty';
                        
                        return (
                          <div
                            key={board.id}
                            className="bg-slate-50 hover:bg-slate-100 rounded-lg p-4 border border-slate-200 transition-colors group"
                          >
                            <div className="flex justify-between items-start gap-4">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="text-xs font-medium text-slate-500">
                                    {dateStr} {timeStr}
                                  </span>
                                  <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">
                                    {board.gridSize}x{board.gridSize}
                                  </span>
                                  {board.wordCount > 0 && (
                                    <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                                      {board.wordCount} words
                                    </span>
                                  )}
                                </div>
                                <div className="text-sm text-slate-600 mb-2 font-mono">
                                  {preview}{board.grid.length > 4 ? '...' : ''}
                                </div>
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => restoreBoard(board)}
                                    className="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md transition-colors"
                                  >
                                    Restore
                                  </button>
                                  <button
                                    onClick={() => deleteBoardFromHistory(board.id)}
                                    className="text-xs px-3 py-1.5 bg-red-100 hover:bg-red-200 text-red-700 rounded-md transition-colors opacity-0 group-hover:opacity-100"
                                  >
                                    Delete
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* RIGHT COLUMN: Results */}
          <section className="lg:col-span-5 h-full">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 h-full flex flex-col min-h-[500px]">
              <h2 className="text-lg font-semibold text-slate-800 mb-4 flex justify-between items-center">
                Found Words
                <span className="bg-indigo-100 text-indigo-700 text-xs px-2 py-1 rounded-full">
                  {foundWords.length}
                </span>
              </h2>

              {foundWords.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-400 p-8 text-center border-2 border-dashed border-slate-100 rounded-xl">
                  {isSolving ? (
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mb-2"></div>
                  ) : (
                    <>
                      <HelpCircle className="w-12 h-12 mb-2 opacity-50" />
                      <p>Enter letters in the grid and click "Find Words" to see results here.</p>
                    </>
                  )}
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 gap-2">
                    {foundWords.map((item, idx) => (
                      <button
                        key={idx}
                        onMouseEnter={() => setHoveredPath(item.path)}
                        onMouseLeave={() => setHoveredPath(null)}
                        className="group relative px-4 py-2 bg-slate-50 hover:bg-indigo-50 rounded-lg text-left transition-colors border border-transparent hover:border-indigo-200"
                      >
                        <span className="font-bold text-slate-700 group-hover:text-indigo-700">
                          {item.word}
                        </span>
                        <span className="text-xs text-slate-400 absolute top-2 right-2 group-hover:text-indigo-400">
                          {item.word.length}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

        </main>
      </div>
      
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: #f1f5f9; 
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #cbd5e1; 
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #94a3b8; 
        }
      `}</style>
    </div>
  );
};

export default BoggleSolver;