import { vectorIdForChunk as vectorId } from "../ingest/vectorId";

export type RagSource = {
	id: string;
	title: string;
	date: string;
	page: string;
	content: string;
};

export type ConversationTurn = {
	role: "user" | "assistant";
	content: string;
};

export const vectorIdForChunk = vectorId;

export function uniqueSourcesByArticle<T extends { article_id: string }>(sources: T[]): T[] {
	const seen = new Set<string>();
	return sources.filter((source) => !seen.has(source.article_id) && (seen.add(source.article_id), true));
}

export function buildRagPrompt(question: string, sources: RagSource[], history: ConversationTurn[] = []): string {
	const evidence = sources
		.map((source, index) => `[${index + 1}] 标题：${source.title}\n日期：${source.date}　版面：${source.page}\n内容：${source.content}`)
		.join("\n\n");
	const context = history
		.slice(-8)
		.map((turn) => `${turn.role === "user" ? "用户" : "助手"}：${turn.content}`)
		.join("\n");
	return `你是中国气象报档案助手。只能依据下列档案证据回答，不得补充档案外事实或猜测。对话上下文仅用于理解指代和追问，绝不能作为事实证据。每个可核查事实后必须标注对应证据编号，如[1]。如证据不足，明确回答“现有档案未提供足够依据”。使用中文。

回答纪律：先判断问题属于哪种任务类型，再选择合适的组织方式；不要输出“任务类型”标签。
- 事实定位：先给直接答案，再补必要背景。
- 清单 / 列举：把同类信息合并为 3—5 个主题，不按检索素材逐条平铺。
- 综合归纳：先给 1—2 句核心判断，再按主要维度展开，最后说明工作逻辑或共同主线。
- 比较 / 变化：按比较维度写相同点、不同点和结论；证据不足时明确说明。
- 因果 / 解释：区分档案直接陈述与合理解释，不能把解释写成事实。
通用要求：先回答问题，再给依据；优先按逻辑关系组织而非检索顺序复述；除非用户要求逐条列举，最多 5 个一级要点；合并重复表述；背景、部署、落实行动要分层写清。

重要限制：你看到的档案证据可能只是全部语料的一部分，绝不能回答“共有X篇”或“有X篇相关报道”这类精确计数问题。如果问题涉及数量，回答“请使用页面上方的检索框获取精确数量”。

${context ? `对话上下文：\n${context}\n\n` : ""}问题：${question}\n\n档案证据：\n${evidence}`;
}
