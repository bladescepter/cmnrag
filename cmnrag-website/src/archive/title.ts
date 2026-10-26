/** 兼容历史副题；对外只使用完整标题。原文标点与破折号保持不变。 */
export function completeTitle(title: string, subtitle = ""): string {
	const main = title.trim();
	const sub = subtitle.trim();
	return sub && !main.includes(sub) ? `${main} ${sub}`.trim() : main;
}

export function withCompleteTitle<T extends { title: unknown; subtitle?: unknown }>(row: T): Omit<T, "title" | "subtitle"> & { title: string } {
	const { title, subtitle, ...rest } = row;
	return {
		...rest,
		title: completeTitle(typeof title === "string" ? title : "", typeof subtitle === "string" ? subtitle : ""),
	};
}
