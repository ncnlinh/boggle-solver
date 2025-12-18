// Trie data structure for efficient prefix checking
// This allows us to prune invalid paths early during DFS

class TrieNode {
  constructor() {
    this.children = {};
    this.isWord = false;
  }
}

export class Trie {
  constructor() {
    this.root = new TrieNode();
  }

  // Insert a word into the trie
  insert(word) {
    let node = this.root;
    for (const char of word) {
      if (!node.children[char]) {
        node.children[char] = new TrieNode();
      }
      node = node.children[char];
    }
    node.isWord = true;
  }

  // Check if a word exists in the trie
  has(word) {
    let node = this.root;
    for (const char of word) {
      if (!node.children[char]) {
        return false;
      }
      node = node.children[char];
    }
    return node.isWord;
  }

  // Check if a prefix exists (for early pruning)
  hasPrefix(prefix) {
    let node = this.root;
    for (const char of prefix) {
      if (!node.children[char]) {
        return false;
      }
      node = node.children[char];
    }
    return true; // Prefix exists, even if not a complete word
  }

  // Get the node for a prefix (useful for incremental checking)
  getNode(prefix) {
    let node = this.root;
    for (const char of prefix) {
      if (!node.children[char]) {
        return null;
      }
      node = node.children[char];
    }
    return node;
  }

  // Check if a character can follow a prefix
  canExtend(prefix, char) {
    const node = this.getNode(prefix);
    return node && node.children[char] !== undefined;
  }
}

// Build a Trie from an array of words
export function buildTrie(words) {
  const trie = new Trie();
  for (const word of words) {
    trie.insert(word);
  }
  return trie;
}
