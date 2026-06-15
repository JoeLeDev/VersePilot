import fs from "fs";
import path from "path";

export function verseKey(v) {
  return `${v.book}|${v.chapter}|${v.verse}`;
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Convertit similarité cosinus (0–1) en score affiché type Pewbeam (35–89). */
export function similarityToScore(sim, source = "semantic") {
  if (source === "reference") {
    return Math.min(99, Math.round(sim));
  }
  const clamped = Math.max(0, Math.min(1, sim));
  return Math.min(89, Math.max(35, Math.round(((clamped - 0.32) / 0.45) * 54 + 35)));
}

/**
 * Construit le suffixe de fichier d'index selon le fournisseur d'embeddings.
 * - openai (défaut historique) : `${slug}.embeddings.*`
 * - local                      : `${slug}.local.embeddings.*`
 */
export function embeddingVariantSuffix(variant) {
  return variant && variant !== "openai" ? `.${variant}` : "";
}

export function loadEmbeddingIndex(biblesDir, slug, variant = "openai") {
  const suffix = embeddingVariantSuffix(variant);
  const metaPath = path.join(biblesDir, `${slug}${suffix}.embeddings.meta.json`);
  const binPath = path.join(biblesDir, `${slug}${suffix}.embeddings.bin`);
  if (!fs.existsSync(metaPath) || !fs.existsSync(binPath)) {
    return null;
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  const buf = fs.readFileSync(binPath);
  const vectors = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT
  );

  const expected = meta.count * meta.dimensions;
  if (vectors.length !== expected) {
    throw new Error(
      `Index embeddings invalide (${slug}): attendu ${expected} floats, reçu ${vectors.length}`
    );
  }

  return { ...meta, vectors };
}

export function getEmbeddingForIndex(index, verseIdx) {
  const { dimensions, vectors } = index;
  const start = verseIdx * dimensions;
  return vectors.subarray(start, start + dimensions);
}
