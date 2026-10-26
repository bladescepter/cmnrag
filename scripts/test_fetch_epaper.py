"""标题与作者排序回归测试：python -m unittest discover -s scripts -p 'test_fetch_epaper.py'。"""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fetch_epaper import apply_archive_titles, complete_title, extract_authors, main, process_article, title_field


class AuthorOrderTests(unittest.TestCase):
    def test_report_byline_precedes_photo_and_api_order(self):
        body = "本报讯 记者 吴彤蒋芷晴 报道4月22日，气象分论坛举行。\n图/张奥光文/吴彤"
        self.assertEqual(
            extract_authors({"docAuthor": "张奥光 吴彤 蒋芷晴"}, body),
            "吴彤 蒋芷晴 张奥光",
        )

    def test_report_without_api_author(self):
        body = "本报讯 记者 吴彤蒋芷晴 报道会议消息。\n图/张奥光文/吴彤"
        self.assertEqual(extract_authors({}, body), "吴彤 蒋芷晴 张奥光")

    def test_first_line_byline_precedes_photo(self):
        body = "吴彤\n这是一篇文字报道。\n图/张奥光"
        self.assertEqual(extract_authors({}, body), "吴彤 张奥光")

    def test_parenthesized_byline_precedes_photo_and_api(self):
        body = "这是一篇文字报道。（吴彤蒋芷晴）\n图/张奥光"
        self.assertEqual(
            extract_authors({"docAuthor": "张奥光"}, body),
            "吴彤 蒋芷晴 张奥光",
        )

    def test_compiler_precedes_photo(self):
        body = "这是一篇编译报道。\n（来源：机构官网编译：吴彤）\n图/张奥光"
        self.assertEqual(extract_authors({}, body), "吴彤 张奥光")

    def test_explicit_text_role_precedes_photo_in_report(self):
        self.assertEqual(
            extract_authors({}, "这是一篇文字报道。\n图/张奥光文/吴彤"),
            "吴彤 张奥光",
        )

    def test_inline_photo_credit_is_appended_to_report_byline(self):
        body = "本报讯 记者 吴彤 报道会议消息。\n图为会议现场。图/张奥光"
        self.assertEqual(extract_authors({}, body), "吴彤 张奥光")

    def test_api_supplements_report_before_photo(self):
        body = "本报讯 记者 吴彤 报道会议消息。\n图/张奥光"
        self.assertEqual(
            extract_authors({"docAuthor": "张奥光 蒋芷晴 吴彤"}, body),
            "吴彤 蒋芷晴 张奥光",
        )

    def test_shared_text_and_photo_author_is_not_duplicated(self):
        body = "本报讯 记者 吴彤蒋芷晴 报道会议消息。\n图/蒋芷晴文/吴彤"
        self.assertEqual(extract_authors({}, body), "吴彤 蒋芷晴")

    def test_picture_news_preserves_caption_order_over_api(self):
        self.assertEqual(
            extract_authors(
                {"docAuthor": "吴彤 张奥光"},
                "图/张奥光文/吴彤",
                "图片新闻",
                is_pic=True,
            ),
            "张奥光 吴彤",
        )

    def test_picture_news_preserves_order_across_credit_formats(self):
        self.assertEqual(
            extract_authors({}, "图为会议现场。图/张奥光\n文/吴彤", is_pic=True),
            "张奥光 吴彤",
        )

    def test_picture_news_handles_wrapped_joint_credit(self):
        self.assertEqual(
            extract_authors({"docAuthor": "文张奥光"}, "图/\n文张奥光", is_pic=True),
            "张奥光",
        )

    def test_cartoon_preserves_role_order(self):
        self.assertEqual(
            extract_authors(
                {"docAuthor": "吴彤"},
                "策划创作/张奥光 蒋芷晴 文/吴彤",
                "漫评：天气与生活",
            ),
            "张奥光 蒋芷晴 吴彤",
        )

    def test_cartoon_preserves_photo_then_text(self):
        self.assertEqual(
            extract_authors({}, "图/张奥光文/吴彤", "漫评"),
            "张奥光 吴彤",
        )

    def test_api_only_fallback(self):
        self.assertEqual(
            extract_authors({"docAuthor": "本报记者吴彤 通讯员蒋芷晴"}, "会议消息。"),
            "吴彤 蒋芷晴",
        )

    def test_photo_author_only_is_retained(self):
        self.assertEqual(
            extract_authors({"docAuthor": "张奥光"}, "报道正文。\n图/张奥光"),
            "张奥光",
        )

    def test_unsigned_commentary_stays_empty(self):
        self.assertEqual(extract_authors({}, "本报评论员\n坚持实干担当。"), "")


class FullTitleTests(unittest.TestCase):
    def test_keeps_kicker_title_and_subtitle_in_source_order(self):
        self.assertEqual(
            complete_title("主标题——原有后半句", "引题&nbsp;", "<b>——副题</b>"),
            "引题 主标题——原有后半句 ——副题",
        )

    def test_does_not_repeat_existing_parts_or_null_values(self):
        self.assertEqual(complete_title("引题 主标题——副题", "引题", "——副题"), "引题 主标题——副题")
        self.assertEqual(complete_title("主标题", None, "null"), "主标题")

    def test_title_field_preserves_yaml_sensitive_punctuation(self):
        title = '天气: “变化” #观察\n后续'
        self.assertEqual(json.loads(title_field(title).split(": ", 1)[1]), title)

    def test_all_fetch_entrypoints_write_full_title_without_subtitle(self):
        data = {"docTitle": "主标题——后半句", "yt": "引题", "fb": "——副题", "content": "正文内容。" * 30}
        expected = "引题 主标题——后半句 ——副题"
        with tempfile.TemporaryDirectory() as directory:
            filename, _ = process_article(data, "一版", 1, "20260430", directory, "要闻")
            single = (Path(directory) / "一版" / filename).read_text(encoding="utf-8")
            self.assertIn(title_field(expected), single)
            self.assertNotIn("\nsubtitle:", single)

        def api(url, payload):
            if url.endswith("findBmMenu.do"):
                return [{"IRCATELOG": "01", "BM": "要闻", "JPPATH": ""}]
            if url.endswith("getBmDetail.do"):
                return [{"ZB_GUID": "test-guid", "DOCTITLE": "列表短标题"}]
            return data

        with tempfile.TemporaryDirectory() as directory, \
                patch("fetch_epaper.month_dir", return_value=directory), \
                patch("fetch_epaper.curl_post", side_effect=api), \
                patch("fetch_epaper.time.sleep"), \
                patch("builtins.print"):
            main("20260430")
            files = list(Path(directory).rglob("*.md"))
            self.assertEqual(len(files), 1)
            daily = files[0].read_text(encoding="utf-8")
            self.assertIn(title_field(expected), daily)
            self.assertNotIn("\nsubtitle:", daily)


class ArchiveTitleApplyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.source = self.root / "202604/20260402/一版/01-主标题.md"
        self.source.parent.mkdir(parents=True)
        self.original = ('---\ntype: 报道\ntitle: 主标题\nsubtitle: ——副题\nauthor:\n  - 吴彤\n'
                         'date: 2026-04-02\ncolumn:\n  - 时评\nregion: \n---\n\n正文原样。\n  缩进与空行。\n')
        self.source.write_text(self.original, encoding="utf-8")
        self.manifest = {"scope": "202604", "pages": {"20260402_01": {"reviewed": True}}, "articles": [{
            "file": str(self.source.relative_to(self.root)),
            "source_sha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
            "old_title": "主标题", "old_subtitle": "——副题", "title": "引题 主标题 ——副题", "matched": True,
        }]}
        self.manifest_path = self.root / "column_test/202604_archive_titles.json"
        self.manifest_path.parent.mkdir()
        self.save_manifest()
        self.patches = [patch("fetch_epaper.OUT_BASE", str(self.root)),
                        patch("fetch_epaper.PROJECT_ROOT", str(self.root)), patch("builtins.print")]
        for item in self.patches:
            item.start()

    def save_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest, ensure_ascii=False), encoding="utf-8")

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.directory.cleanup()

    def test_preview_leaves_source_untouched_then_apply_preserves_other_fields_and_body(self):
        import yaml
        apply_archive_titles("202604", dry_run=True)
        self.assertEqual(self.source.read_text(encoding="utf-8"), self.original)
        apply_archive_titles("202604")
        destination = self.source.with_name("01-引题 主标题 ——副题.md")
        self.assertFalse(self.source.exists())
        updated = destination.read_text(encoding="utf-8")
        before, before_body = self.original.split("\n---\n", 1)
        after, after_body = updated.split("\n---\n", 1)
        self.assertEqual(before_body, after_body)
        before_fm, after_fm = yaml.safe_load(before[4:]), yaml.safe_load(after[4:])
        before_fm.pop("subtitle")
        before_fm["title"] = "引题 主标题 ——副题"
        self.assertEqual(before_fm, after_fm)
        self.assertNotIn("subtitle:", updated)

    def test_rejects_unreviewed_pages_before_writing(self):
        self.manifest["pages"]["20260402_01"]["reviewed"] = False
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "尚未逐版核对"):
            apply_archive_titles("202604")
        self.assertEqual(self.source.read_text(encoding="utf-8"), self.original)

    def test_rejects_incomplete_scope(self):
        self.source.with_name("02-其他稿.md").write_text(self.original, encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "未完整覆盖"):
            apply_archive_titles("202604")

    def test_rejects_source_changes_since_review(self):
        self.source.write_text(self.original + "审核后新增正文。", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "发生变更"):
            apply_archive_titles("202604")


if __name__ == "__main__":
    unittest.main()
