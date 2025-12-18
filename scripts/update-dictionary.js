import { createReadStream, writeFileSync } from "fs";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const SOURCE_FILE = join(__dirname, "../src/safedict_full.txt");
const OUTPUT_FILE = join(__dirname, "../src/dictionary.js");

console.log("📖 Reading and filtering dictionary file...");
console.time("Processing time");

// Use a Set for O(1) deduplication instead of O(n) array indexOf
const wordSet = new Set();
let totalLines = 0;
let validWords = 0;

// Stream the file line by line instead of loading entire file into memory
const rl = createInterface({
  input: createReadStream(SOURCE_FILE),
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  totalLines++;

  // Show progress every 50k lines
  if (totalLines % 50000 === 0) {
    console.log(`  Processed ${totalLines.toLocaleString()} lines...`);
  }

  const word = line.trim().toUpperCase();

  // Filter: only words with 3+ characters and alphabetic only
  if (word.length >= 3 && /^[A-Z]+$/.test(word)) {
    wordSet.add(word);
    validWords++;
  }
});

rl.on("close", () => {
  console.log(`✅ Processed ${totalLines.toLocaleString()} lines`);
  console.log(
    `✅ Found ${validWords.toLocaleString()} valid words, ${wordSet.size.toLocaleString()} unique`
  );

  // Convert Set to sorted array
  const words = Array.from(wordSet).sort();

  console.log("💾 Writing dictionary.js...");

  // Generate the dictionary.js content with a Set for faster lookups
  const dictionaryContent = `// Dictionary of valid words for Boggle
// Auto-generated from safedict_full.txt
// Contains ${words.length.toLocaleString()} unique words (minimum 3 characters)
// Using Set for O(1) lookup performance

const DICT_ARRAY = [
${words.map((word) => `  "${word}"`).join(",\n")}
];

// Export as a Set for faster lookups during solving
export const DICTIONARY = new Set(DICT_ARRAY);

// Export array version if needed for other purposes
export const DICTIONARY_ARRAY = DICT_ARRAY;
`;

  writeFileSync(OUTPUT_FILE, dictionaryContent, "utf-8");

  console.log(`✅ Updated ${OUTPUT_FILE}`);
  console.log(
    `📊 Total unique words in dictionary: ${words.length.toLocaleString()}`
  );
  console.timeEnd("Processing time");
});
