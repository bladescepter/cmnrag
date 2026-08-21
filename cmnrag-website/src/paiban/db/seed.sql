-- 初始全局设置: 人员名单 + 周五轮换顺序 + 休假管理
INSERT INTO settings (id, members_json, friday_rotation_json, exclusions_json) VALUES (
  1,
  '[
    {"name":"黄彬","role":"both"},
    {"name":"刘钊","role":"first_only"},
    {"name":"文科","role":"both"},
    {"name":"王亮","role":"inactive"},
    {"name":"赵宁","role":"both"},
    {"name":"叶奕宏","role":"both"},
    {"name":"吴彤","role":"both"},
    {"name":"刘丹","role":"inactive"},
    {"name":"史光浩","role":"second_only"},
    {"name":"张宏伟","role":"both"},
    {"name":"王畅","role":"both"},
    {"name":"李悦","role":"both"},
    {"name":"郭笑羽","role":"both"}
  ]',
  '["黄彬","吴彤","叶奕宏","文科","李悦","张宏伟","赵宁","王畅","刘钊","郭笑羽"]',
  '[]'
);

-- 见报日历种子: 2026 年节假日 (休刊)
-- 见报日历默认规则: 周一至周五见报, 以下日期为休刊覆盖
INSERT INTO calendar (date, type, name) VALUES
  ('2026-01-02','holiday','元旦'),
  ('2026-02-16','holiday','春节'),
  ('2026-02-17','holiday','春节'),
  ('2026-02-18','holiday','春节'),
  ('2026-02-19','holiday','春节'),
  ('2026-02-20','holiday','春节'),
  ('2026-02-23','holiday','春节'),
  ('2026-04-06','holiday','清明节'),
  ('2026-05-01','holiday','劳动节'),
  ('2026-05-04','holiday','劳动节'),
  ('2026-05-05','holiday','劳动节'),
  ('2026-06-19','holiday','端午节'),
  ('2026-09-25','holiday','中秋节'),
  ('2026-10-01','holiday','国庆节'),
  ('2026-10-02','holiday','国庆节'),
  ('2026-10-05','holiday','国庆节'),
  ('2026-10-06','holiday','国庆节'),
  ('2026-10-07','holiday','国庆节');
