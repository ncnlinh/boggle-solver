import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { RefreshCw, Grid, CheckCircle, HelpCircle, Copy, Clipboard, History, X } from 'lucide-react';
import { DICTIONARY, DICTIONARY_ARRAY } from './dictionary_full.js';
import { buildTrie } from './trie.js';

const STORAGE_KEY = 'boggle-historic-boards';
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
  const inputRefs = useRef([]);
  const solvingRef = useRef(false);

  // Build Trie once on mount - this is expensive but only done once
  const dictionaryTrie = useMemo(() => {
    return buildTrie(DICTIONARY_ARRAY);
  }, []);

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
    setGrid(Array(gridSize * gridSize).fill(''));
    setFoundWords([]);
    setHoveredPath(null);
    inputRefs.current = inputRefs.current.slice(0, gridSize * gridSize);
  }, [gridSize]);

  // Handle individual cell input
  const handleInputChange = (index, value) => {
    const newGrid = [...grid];
    const upperValue = value.toUpperCase();
    
    // If the value is exactly "QU", keep it
    if (upperValue === 'QU') {
      newGrid[index] = 'QU';
    } else {
      // Take the last character typed
      const lastChar = upperValue.slice(-1);
      
      // Transform Q to QU automatically
      if (lastChar === 'Q') {
        newGrid[index] = 'QU';
      } else if (lastChar) {
        // Replace with the new character (handles case where QU cell gets a new char)
        newGrid[index] = lastChar;
      } else {
        newGrid[index] = '';
      }
    }
    
    setGrid(newGrid);

    // Auto-focus next cell if a single character is entered (not QU)
    const cellValue = newGrid[index];
    if (cellValue && cellValue.length === 1 && index < grid.length - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (e, index) => {
    if (e.key === 'Backspace' && !grid[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
    // Arrow key navigation
    if (e.key === 'ArrowRight' && index < grid.length - 1) inputRefs.current[index + 1]?.focus();
    if (e.key === 'ArrowLeft' && index > 0) inputRefs.current[index - 1]?.focus();
    if (e.key === 'ArrowDown' && index + gridSize < grid.length) inputRefs.current[index + gridSize]?.focus();
    if (e.key === 'ArrowUp' && index - gridSize >= 0) inputRefs.current[index - gridSize]?.focus();
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
          const nextWord = currentWord + grid[neighbor];
          
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
        await dfs(i, grid[i], [i], visited);
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

  // Parse pasted text into grid
  const handlePaste = useCallback((e) => {
    e.preventDefault();
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    
    if (!text) return;
    
    // Parse the text: split by newlines, then by tabs or spaces
    const lines = text.trim().split(/\r?\n/).filter(line => line.trim());
    const parsedGrid = [];
    
    for (const line of lines) {
      // Split by tabs first (most common), then by multiple spaces, then by single spaces
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
        // Handle QU - if cell starts with Q, convert to QU
        if (trimmed.startsWith('Q')) {
          return 'QU';
        }
        // Otherwise take first character
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
      setGridSize(numRows);
      const newGrid = Array(numRows * numRows).fill('');
      for (let i = 0; i < Math.min(parsedGrid.length, numRows * numRows); i++) {
        newGrid[i] = parsedGrid[i] || '';
      }
      setGrid(newGrid);
      inputRefs.current[0]?.focus();
    } else if (parsedGrid.length >= gridSize * gridSize) {
      // Use current grid size if we have enough cells
      const newGrid = Array(gridSize * gridSize).fill('');
      for (let i = 0; i < Math.min(parsedGrid.length, gridSize * gridSize); i++) {
        newGrid[i] = parsedGrid[i] || '';
      }
      setGrid(newGrid);
      inputRefs.current[0]?.focus();
    } else if (parsedGrid.length > 0) {
      // Try to infer grid size from total number of cells
      const inferredSize = Math.ceil(Math.sqrt(parsedGrid.length));
      if (inferredSize >= 4 && inferredSize <= 6) {
        setGridSize(inferredSize);
        const newGrid = Array(inferredSize * inferredSize).fill('');
        for (let i = 0; i < Math.min(parsedGrid.length, inferredSize * inferredSize); i++) {
          newGrid[i] = parsedGrid[i] || '';
        }
        setGrid(newGrid);
        inputRefs.current[0]?.focus();
      }
    }
  }, [gridSize]);

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
    const hue = progress * 0; // Interpolate from 0 (red) to 60 (yellow)
    const saturation = 100 - (progress * 20); // Keep saturation high for vibrant colors
    const lightness = 35 + (progress * 20); // Interpolate from 35% (dark) to 70% (lighter but readable)
    
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
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          
          {/* LEFT COLUMN: Grid Input */}
          <section className="lg:col-span-7 flex flex-col gap-6">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold text-slate-800">Grid Input</h2>
                <div className="flex items-center gap-2">
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
                </div>
              </div>

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
                        maxLength={cell === 'QU' ? 2 : 1}
                        className={`w-full h-full text-center font-bold rounded-xl border-2 uppercase outline-none transition-all duration-200
                          ${cell === 'QU' ? 'text-xl md:text-2xl' : 'text-2xl md:text-3xl'}
                          ${isHighlighted 
                            ? 'text-slate-900 scale-105 z-10 shadow-lg' 
                            : 'border-slate-200 bg-slate-50 text-slate-800 focus:border-indigo-400 focus:bg-white'
                          }
                        `}
                        style={isHighlighted ? {
                          backgroundColor: rainbowColor,
                          borderColor: rainbowColor
                        } : {}}
                      />
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

              <div className="mt-8 flex justify-center">
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