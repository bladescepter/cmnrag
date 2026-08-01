const splitSentences = (paragraph: string) => {
	const sentences = paragraph.match(/[^。！？!?]+[。！？!?]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [paragraph];
	return sentences;
};

export function chunkArticle(content: string, targetChars = 1000): string[] {
	const paragraphs = content.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
	const units = paragraphs.flatMap((paragraph) => paragraph.length > targetChars ? splitSentences(paragraph) : [paragraph]);
	const chunks: string[] = [];
	let current: string[] = [];
	let currentLength = 0;
	for (const unit of units) {
		const separator = current.length ? 2 : 0;
		if (current.length && currentLength + separator + unit.length > targetChars) {
			chunks.push(current.join("\n\n"));
			current = [];
			currentLength = 0;
		}
		current.push(unit);
		currentLength += (current.length > 1 ? 2 : 0) + unit.length;
	}
	if (current.length) chunks.push(current.join("\n\n"));
	return chunks;
}
