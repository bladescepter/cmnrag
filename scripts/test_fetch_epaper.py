"""标题与作者排序回归测试：python -m unittest discover -s scripts -p 'test_fetch_epaper.py'。"""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fetch_epaper import apply_archive_titles, complete_title, extract_authors, main, print_review_table, process_article, title_field


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


    def test_split_briefs_keep_the_complete_first_sentence(self):
        first = "近日，天津市气象局与交通运输部北海航海保障中心达成合作共识。"
        second = "内蒙古自治区气象局联合自治区农牧厅组建专项调研组，赴巴彦淖尔市开展向日葵产业气象服务专题调研。"
        data = {"docTitle": "要闻简报", "content": f"本报讯{first}双方深化合作，完善业务交流机制，共同提升海上气象保障服务能力。（吴彤）\n本报讯{second}调研组走访当地产业基地，精准对接服务需求。（蒋芷晴）"}

        def api(url, payload):
            if url.endswith("findBmMenu.do"):
                return [{"IRCATELOG": "01", "BM": "要闻", "JPPATH": ""}]
            if url.endswith("getBmDetail.do"):
                return [{"ZB_GUID": "brief-guid", "DOCTITLE": "要闻简报"}]
            return data

        with tempfile.TemporaryDirectory() as directory, \
                patch("fetch_epaper.month_dir", return_value=directory), \
                patch("fetch_epaper.curl_post", side_effect=api), \
                patch("fetch_epaper.time.sleep"), patch("builtins.print"):
            main("20260318")
            files = sorted(Path(directory).rglob("*.md"))
            self.assertEqual(len(files), 2)
            for path, expected in zip(files, (first, second)):
                self.assertIn(title_field(expected), path.read_text(encoding="utf-8"))


class ArchiveTitleApplyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.source = self.root / "202604/20260402/一版/01-主标题.md"
        self.source.parent.mkdir(parents=True)
        self.original = ('---\ntype: 报道\ntitle: 主标题\nsubtitle: ——副题\nauthor:\n  - 吴彤\n'
                         'date: 2026-04-02\npage: 一版\ncolumn:\n  - 时评\nregion: \n---\n\n正文原样。\n  缩进与空行。\n')
        self.source.write_text(self.original, encoding="utf-8")
        self.image = self.root / "layout.jpg"
        from PIL import Image
        Image.new("RGB", (8, 8), "white").save(self.image)
        self.manifest = {"scope": "202604", "pages": {"20260402_01": {"reviewed": True, "image": str(self.image)}}, "articles": [{
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


    def test_requires_actual_layout_evidence_even_when_marked_reviewed(self):
        self.manifest["pages"]["20260402_01"]["image"] = ""
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "缺少实际版面"):
            apply_archive_titles("202604", dry_run=True)
        self.assertEqual(self.source.read_text(encoding="utf-8"), self.original)

    def test_rejects_missing_layout_file(self):
        self.manifest["pages"]["20260402_01"]["image"] = str(self.root / "missing.pdf")
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "缺少实际版面"):
            apply_archive_titles("202604")

    def test_layout_corrected_title_wins_over_api_candidate(self):
        self.manifest["articles"][0]["api"] = {"docTitle": "观局 谋势 奋斗"}
        self.manifest["articles"][0]["title"] = "观局 谋势 奋进 —解码新词热词"
        self.save_manifest()
        apply_archive_titles("202604")
        destination = self.source.with_name("01-观局 谋势 奋进 —解码新词热词.md")
        self.assertIn(title_field("观局 谋势 奋进 —解码新词热词"), destination.read_text(encoding="utf-8"))

    def test_review_table_keeps_full_title_and_all_field_values(self):
        title = "引题 " + "完整主标题" * 20 + " ——完整副题"
        authors = ["作者甲", "作者乙", "作者丙", "作者丁", "作者戊"]
        regions = ["青海省海西蒙古族藏族自治州格尔木市", "西藏自治区那曲市"]
        columns = ["科普看台", "我们的纪念日"]
        text = self.original.replace("  - 吴彤", "\n".join("  - " + name for name in authors))
        text = text.replace("region: ", "region:\n" + "\n".join("  - " + value for value in regions))
        text = text.replace("  - 时评", "\n".join("  - " + value for value in columns))
        self.source.write_text(text, encoding="utf-8")
        self.manifest["articles"][0].update(title=title, source_sha256=hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.save_manifest()
        apply_archive_titles("202604")
        with patch("builtins.print") as output:
            print_review_table("202604")
        table = output.call_args.args[0]
        for value in [title, *authors, *regions, *columns]:
            self.assertIn(value, table)
        self.assertIn("共 1 篇", table)

    def test_review_table_blocks_unreviewed_layouts(self):
        self.manifest["pages"]["20260402_01"]["reviewed"] = False
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "尚未逐版核对"):
            print_review_table("202604")

    def test_review_table_blocks_title_changes_after_layout_review(self):
        apply_archive_titles("202604")
        destination = self.source.with_name("01-引题 主标题 ——副题.md")
        destination.write_text(destination.read_text(encoding="utf-8").replace(title_field("引题 主标题 ——副题"), title_field("被截短的主标题")), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "标题与版面核定结果不一致"):
            print_review_table("202604")

    def test_review_table_blocks_omitted_articles(self):
        apply_archive_titles("202604")
        self.source.with_name("02-遗漏的稿件.md").write_text(self.original, encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "未完整覆盖"):
            print_review_table("202604")


class LayoutEvidenceTests(unittest.TestCase):
    def test_original_layout_survives_temporary_image_cleanup(self):
        from PIL import Image
        from col_vision_run import prepare_page
        from column_detect import cleanup_page_images

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "20260316_02.jpg"
            Image.new("RGB", (40, 60), "blue").save(original)
            original_bytes = original.read_bytes()
            with patch("col_vision_run.OUT_DIR", directory), \
                    patch("column_detect.OUT_DIR", directory), \
                    patch("col_vision_run.get_page_data", return_value={"jppath": "layout.jpg", "articles": []}), \
                    patch("col_vision_run.download_image", return_value=str(original)), \
                    patch("builtins.print"):
                prepare_page("20260316", "02")
                cleanup_page_images("20260316", "02")
            self.assertFalse(original.exists())
            self.assertEqual((root / "title_evidence/20260316_02.jpg").read_bytes(), original_bytes)


if __name__ == "__main__":
    unittest.main()
