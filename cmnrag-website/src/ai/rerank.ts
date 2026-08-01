export type RerankResult = { index: number; score?: number };

export function rerankSources<T extends { article_id: string }>(candidates: T[], ranking: RerankResult[]): T[] {
	const seen = new Set<string>();
	return ranking
		.map(({ index }) => candidates[index])
		.filter((candidate): candidate is T => Boolean(candidate))
		.filter((candidate) => !seen.has(candidate.article_id) && (seen.add(candidate.article_id), true));
}

export function chooseEvidenceCount(availableArticles: number): number {
	if (availableArticles <= 6) return availableArticles;
	return Math.min(8, availableArticles);
}
