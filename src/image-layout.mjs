/**
 * Calculate readable vertical slices for a tall image.
 *
 * The image is not modified. Each slice uses Word's percentage crop, so a
 * single PNG can be displayed across several pages at the full text width.
 */
export function imageCropSegments(image, page, reserve = 0) {
  const availableWidth = Math.max(1, (page.width - page.left - page.right) / 15 - 4);
  const availableHeight = Math.max(1, (page.height - page.top - page.bottom) / 15 - reserve);
  if (!image?.width || !image?.height) return [];

  const heightAtFullWidth = image.height * availableWidth / image.width;
  const count = Math.max(1, Math.ceil((heightAtFullWidth - 0.5) / availableHeight));
  if (count === 1) {
    const scale = Math.min(availableWidth / image.width, availableHeight / image.height, 1);
    return [{
      width: Math.max(1, Math.floor(image.width * scale)),
      height: Math.max(1, Math.floor(image.height * scale)),
    }];
  }

  const segmentHeight = image.height / count;
  return Array.from({ length: count }, (_, index) => ({
    width: Math.max(1, Math.floor(availableWidth)),
    height: Math.max(1, Math.min(
      Math.floor(availableHeight),
      Math.floor(segmentHeight * availableWidth / image.width),
    )),
    crop: {
      top: index * 100 / count,
      bottom: (count - index - 1) * 100 / count,
    },
  }));
}

/**
 * Keep only the first document placement for identical image bytes.
 * Node text and tables are retained; only repeated picture placements are removed.
 */
export function dedupeSectionImages(sections, digest) {
  const seen = new Set();
  for (const section of sections) {
    section.screenshots = (section.screenshots || []).filter(screenshot => {
      const key = screenshot.image?.data && digest(screenshot.image.data);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return sections;
}

/**
 * Keep the first occurrence of an identical business rule across nodes.
 * Node-specific differences remain as separate strings and are not merged.
 */
export function dedupeSectionRules(sections) {
  const seen = new Set();
  for (const section of sections) {
    section.rules = (section.rules || []).filter(rule => {
      const key = String(rule).trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return sections;
}
