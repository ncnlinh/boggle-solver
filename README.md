# Boggle Party Solver

A beautiful, interactive Boggle solver built with React, Vite, and Tailwind CSS. Enter your Boggle grid, customize the dictionary, and instantly find all possible words!

## Features

- 🎯 **Interactive Grid Input** - 4x4, 5x5, or 6x6 grid sizes
- 🔍 **Smart Word Finding** - Efficient DFS algorithm to find all valid words
- 📚 **Expandable Dictionary** - Edit `src/dictionary.js` to add more words
- 🎨 **Beautiful UI** - Modern design with smooth animations
- 🖱️ **Hover to Highlight** - See the path of each word on the grid
- ⌨️ **Keyboard Navigation** - Arrow keys and auto-focus for quick entry

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

3. Open your browser and navigate to:
```
http://localhost:5173
```

## Usage

1. **Choose Grid Size**: Select 4x4, 5x5, or 6x6 from the top-right buttons
2. **Enter Letters**: Click on any cell and type letters. Use arrow keys to navigate
3. **Find Words**: Click "Find Words" to solve the puzzle
4. **View Results**: Hover over found words to see their path on the grid

### Adding More Words

To expand the dictionary, edit the `src/dictionary.js` file and add words to the `DICTIONARY` array.

## Build for Production

To create a production build:

```bash
npm run build
```

The built files will be in the `dist/` directory.

To preview the production build locally:

```bash
npm run preview
```

## Technologies Used

- **React** - UI library
- **Vite** - Build tool and dev server
- **Tailwind CSS** - Styling
- **Lucide React** - Icon library

## How It Works

The solver uses a depth-first search (DFS) algorithm to find all valid words in the grid:

1. Parses the dictionary (minimum 3 letters per word)
2. For each word, checks if all letters exist in the grid
3. Attempts to find a valid path starting from each matching cell
4. Uses backtracking to explore all possible paths
5. Returns results sorted by length and alphabetically

## License

MIT

## Author

Built with ❤️ for Boggle enthusiasts

