import { createHash } from "node:crypto";

export const vectorIdForChunk = (articleId: string, chunkIndex: number) =>
	createHash("sha256").update(`${articleId}:${chunkIndex}`).digest("hex");
