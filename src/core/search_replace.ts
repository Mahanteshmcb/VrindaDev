import { distance } from "fastest-levenshtein";

const SIMILARITY_THRESHOLD = 0.85; 

/**
 * Executes a robust, open-source Fuzzy Search & Replace on a file string.
 * Optimized for code editing where exact matches might fail due to minor whitespace differences.
 */
export function applySearchReplace(
  fileContent: string, 
  searchBlock: string, 
  replaceBlock: string
): string | null {
  
  // DETERMINE THE ORIGINAL LINE ENDING TYPE
  const lineEnding = fileContent.includes("\r\n") ? "\r\n" : "\n";
  
  // 1. Normalize Inputs
  const fileLines = fileContent.split(/\r?\n/);
  const searchLines = searchBlock.split(/\r?\n/);
  const replaceLines = replaceBlock.split(/\r?\n/);

  if (searchLines.length === 0) return null;

  const fileStr = fileLines.join("\n");
  const searchStr = searchLines.join("\n");
  const replaceStr = replaceLines.join("\n");
  
  // 2. Try EXACT Match (Fastest Path)
  if (fileStr.includes(searchStr)) {
      return fileStr.replace(searchStr, replaceStr);
  }

  // 3. Fuzzy Match (Sliding Window + Levenshtein)
  const searchTrimmed = searchLines.map(l => l.trim()).join("\n");
  let bestScore = 0;
  let bestIndex = -1;

  // Optimization: Don't iterate if file is huge and search is tiny, 
  // but for code editing, we need precision. 
  // We iterate through valid start positions.
  for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
    const chunk = fileLines.slice(i, i + searchLines.length);
    const chunkTrimmed = chunk.map(l => l.trim()).join("\n");
    
    // Quick check to skip impossible matches (first line mismatch)
    // Using a looser check for the first line to allow for some variance
    if (fileLines[i].trim() !== searchLines[0].trim()) {
        const firstLineDist = distance(fileLines[i].trim(), searchLines[0].trim());
        const maxLen = Math.max(fileLines[i].trim().length, searchLines[0].trim().length);
        if (maxLen > 0 && (1 - firstLineDist / maxLen) < 0.5) {
             continue; // First line is too different, skip chunk
        }
    }

    // Calculate Similarity for the whole block
    const dist = distance(chunkTrimmed, searchTrimmed);
    const maxLen = Math.max(chunkTrimmed.length, searchTrimmed.length);
    if (maxLen === 0) continue;
    
    const score = 1 - (dist / maxLen);

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }

    if (bestScore > 0.99) break; // Exact match found in trimmed mode
  }

  // 4. Apply Replacement if threshold met
  if (bestScore >= SIMILARITY_THRESHOLD && bestIndex !== -1) {
      
      // Smart Indentation Handling:
      const matchedLine = fileLines[bestIndex];
      const indentMatch = matchedLine.match(/^\s*/);
      const actualIndent = indentMatch ? indentMatch[0] : "";

      // Apply indentation to the replacement block
      const indentedReplaceLines = replaceLines.map((line) => {
          if (line.trim() === "") return line;
          // Only add indent if the replacement line doesn't already have it
          // or if we are assuming the replace block provided is unindented.
          // Strategy: Strip leading whitespace from replace block and apply actualIndent.
          return actualIndent + line.trimStart(); 
      });

      const before = fileLines.slice(0, bestIndex);
      const after = fileLines.slice(bestIndex + searchLines.length);
      
      // Rejoin using the original line ending type
      return [...before, ...indentedReplaceLines].join(lineEnding) + lineEnding + after.join(lineEnding);
  }

  return null; // No match found
}