"""作者排序回归测试：python -m unittest discover -s scripts -p 'test_fetch_epaper.py'。"""
import unittest

from fetch_epaper import extract_authors


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


if __name__ == "__main__":
    unittest.main()
