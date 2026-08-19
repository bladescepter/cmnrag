#!/usr/bin/env python3
"""
报纸数据抓取管线 — 中国气象报电子报 → 结构化 Markdown

用法:
  python3 fetch_epaper.py YYYYMMDD

示例:
  python3 fetch_epaper.py 20260109

输出:
  <项目根>/cmnrag/YYYYMM/YYYYMMDD/一版/01-标题.md ...
  <项目根>/cmnrag/YYYYMM/YYYYMMDD/四版/00-01月DD日四版-版面概览.md

数据目录:
  默认保存在本项目 cmnrag/ 子目录（不再写 VPS /opt/data）。
  可用环境变量 CMNRAG_DATA_DIR 覆盖。

后续步骤 (手动):
  1. 对每个版面截图运行 vision_analyze 识别栏目和头条
  2. 按视觉结果修正 column / headline / region
  3. 拆分"要闻简报"类合并稿件
  4. 补副刊等 API 缺的作者名
"""

import os, re, json, subprocess, sys, time, concurrent.futures, threading

# ===== 配置 =====
API_BASE = "http://epaper.zgqxb.com.cn/reader/layout"
# 数据保存在本项目 cmnrag/ 子目录；可用 CMNRAG_DATA_DIR 覆盖（如 VPS 旧环境）
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_BASE = os.environ.get("CMNRAG_DATA_DIR", os.path.join(PROJECT_ROOT, "cmnrag"))


def month_dir(date_str):
    """按月份分目录，如 <项目根>/cmnrag/202607/20260701/"""
    month = date_str[:6]
    return os.path.join(OUT_BASE, month, date_str)
REGULAR_THEMES = {"要闻", "综合", "党建", "科技", "副刊", "头版"}

CITY_REGION = {}  # 人工审查时补 region，自动提取不可靠


SURNAMES = set(
    '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张'
    '孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎'
    '鲁韦昌马苗凤花方俞任袁柳丰鲍史唐费廉岑薛雷贺倪汤'
    '滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄'
    '穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊'
    '纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅'
    '盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经'
    '房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石吉钮龚程嵇'
    '邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段'
    '富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇'
    '栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿'
    '白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴郁胥能苍双闻莘'
    '党翟谭贡劳逄姬申扶堵冉宰郦雍郤璩桑桂濮牛寿通边扈'
    '燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古'
    '易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳'
    '沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾沙'
    '乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公光'
    '随'
    '他'
    '肖'
)


# 已知作者姓名库（经用户确认的准确分词），新作者名确认后加入
KNOWN_AUTHORS = {
    "丁昕彤", "于桐", "何静怡", "佟迎宾", "侯伟", "冀海鹰", "刘丽媛", "刘凯文", "刘庆忠", "刘淑乔",
    "刘蕊", "叶奕宏", "周佳玲", "周志强", "周本喜", "周浪", "周芳华", "唐悦", "唐淼", "孙林",
    "宋巧云", "崔汝菲", "庄小莉", "张倩", "张妍", "张婷婷", "张广梅", "张志恒", "张怡凡", "张欣彤",
    "张盈盈", "张静华", "彭林", "徐佳", "徐强", "曹雯", "李云逸", "李帅", "李悦", "李慧融",
    "李明瑶", "李根", "李红梅", "李翕然", "李艳", "李隆安", "李雯", "李青松", "杨继国", "林俊君",
    "林禹彤", "海尚飞", "潘锡飞", "玉素甫·吐尔公", "王佳",
    "金丽娜",
    "郭锐",
    "郭军",
    "郝蓬",
    "苏立明",
    "罗云凯",
    "王鹏",
    "王晓",
    "渠翔宇",
    "杨睿",
    "杨栋",
    "李语桐",
    "李倩",
    "李东达",
    "张钰祺",
    "张永兴",
    "张栋",
    "孙帅",
    "卞娟娟",
    "栗婧娟",
    "陈颖",
    "韦铸峰",
    "张宣",
    "马云飞",
    "顾鹏程",
    "刘增一",
    "黄秀花",
    "顾鹏",
    "陈辰",
    "阮洪福",
    "钟鸣",
    "任雪杰", "刘梦雨", "刘超", "吴永建", "吴羽翔", "廖利娟", "张思齐", "张珍珍", "张生梅", "施璐",
    "李义鑫", "李兰兰", "杨林梓", "梁俊聪", "王云亮", "王佳津", "程欢", "罗先猛", "范兴凯", "袁晶",
    "赵伟程", "邓碧娜", "邓钰洋", "郑羡仪", "金文雨", "陈星",
    "余勤", "刘思齐", "刘月", "周文凯", "周裕惠", "孙志清", "宣振华", "张一琼", "彭仕明", "易红梅",
    "李喆", "李婷", "李建坤", "李荣", "杨彦", "杨红龙", "柳东慧", "梁宇清", "王嘉豪", "王娟娟",
    "王蔚娜", "环海军", "罗天羿", "许小峰", "谷会娟", "邢世全", "郭鑫磊", "陈申鹏", "隆振宇", "马宁",
    "高铭", "龙月清",
    "万凌", "云周静", "光爱红", "刘雪芹", "吴其侃", "周静", "姜明", "孙雨阳", "张权益", "戴帅汝",
    "李凡", "李双成", "林江", "柳艳香", "武荣盛", "焦文杰", "王威", "王珂", "王秀俊", "王雪",
    "祝成瑶", "苏子航", "赵晓威", "韦连文", "魏敏丹",
    "邓双双",
    "赵兵",
    "谷铮",
    "裴心媛",
    "薛若浠",
    "苗艳丽",
    "罗丹",
    "窦文嘉",
    
    "王静琪",
    "王文馨",
    "王丽君",
    "桑红珍",
    "杨蕾",
    "杨凡峰",
    "曹睿",
    "张静静",
    "张雨柔",
    "康晟炜",
    "崔一杰",
    "尚雷",
    "周洁",
    "吴琼",
    "南繁",
    "于子敏", "傅新姝", "张思远", "张艳品", "张金平", "徐娜", "李欣", "杨韬", "梁艳", "洪宇",
    "焦希宽", "王倩倩", "王利轩", "王勃勋", "王坤", "王志诚", "葛翔", "薛文博", "赵桂芳", "郝泽楠",
    "郭蓉", "高迁", "魏庆伟", "齐晓华", "马超", "王豫燕", "王继梅",
    "付晓辉", "向秋卓玛", "周宇航", "姚嫚", "姚梦圆", "姜殿荣", "张丹", "张元", "张晴媚", "张静雯",
    "徐伟杰", "李夏君", "林思敏", "毕淼", "毛灏灏", "熊晓辉", "王亚静", "职新利", "蔡一琳", "谢妍",
    "赵鸿", "邓舒予", "郑文君", "郭连云", "陈华忠", "黎陈烨", "陈东辉",
    "卫文芳", "哈斯塔木嘎", "张玮", "张琳皓", "张露丹", "张马兵", "彭华青", "朱燕", "李伊吟", "李兴文",
    "李帅希", "李敏", "李甄甄", "李辉", "李迪", "杨云茜", "段浩", "涂志坚", "王晓峰", "白璐",
    "童红梅", "罗妮妮", "范倩文", "谢盼", "赵现纲", "郑勇",
    "刘曙红", "吴拓", "孙少杰", "宛霞", "庞镜阳", "张玉婷", "张钤", "彭明霞", "李信君", "李森",
    "杨芳", "洪闽", "王小宁", "王彦峰", "王迎迎", "程远", "胡兴才", "袁旷卓", "许肖璐", "许钰文",
    "谢冰", "赖芬芬", "郭华", "郭圳勉", "阮惠华", "阴汝冰", "陆艳", "马兆越",
    "任勇", "冀雅琴", "刘明", "刘春红", "卜钰", "史国庆", "廉沫", "彭明雅", "徐卓远", "慕万峰",
    "李海强", "李路华", "李钫城", "楚合涛", "武蓓蓓", "洪梅青", "温文", "王晋文", "王萌萌", "范晔",
    "赖雨", "郑江伟", "郭子健", "阮帆", "陈学杰", "陈彩珠", "韩萌萌", "高华金",
    "吉拿石达", "左希斌", "张阔", "曹源", "李相伯", "潘文亮", "王敬涛", "秦玉梅", "秦静", "罗嘉祺", "苑彩霞", "郑亮", "郭善云",
    
    "任崇勇",
    "仇梦扬",
    "乌雅汗",
    "任姚雷",
    "姚雷",
    "孙俊杰",
    "高迅芝",
    "颜佳",
    "陈杰",
    "邱璟怡",
    "邓伟",
    "赵静",
    "赵春霞",
    "赵寰洲",
    "裴倩",
    "秦霞",
    "王丽霞",
    "潘彭刚",
    "李翠玲",
    "李磊",
    "权永军",
    "张争",
    "宋杨",
    "宋文锦",
    "孟亚楠",
    "孙瑜",
    "孙斌",
    "姬雪帅",
    "刘爽",
    "刘晓晶",
    "顾斌",
    "陈筱秋",
    "钟军",
    "赵宇扬",
    "蔡成瑶",
    "蒲秀姝",
    "翟蕾",
    "皮小雯",
    "王晨珏",
    "王启蒙",
    "王丹丹",
    "杜征宇",
    "李晓雪",
    "徐灵芝",
    "张绪",
    "张丽亚",
    "哈妮",
    "周雯",
    "周爱春",
    "古德",
    "刘玥",
    "代蕊",
    "韦宏江",
    "黄元荣",
    "黎微微",
    "黄元",
    "马辉",
    "陈金阳",
    "陈丹",
    "陈一晖",
    "钟颖婷",
    "邱龙燕",
    "赵艳妮",
    "贾辰",
    "林树勋",
    "杨阳",
    "杨晓玲",
    "杜欣恒",
    "李红",
    "李国玉",
    "李京校",
    "张鑫明",
    "张美丽",
    "常书瑜",
    "尹家智",
    "封慧杰",
    "安明",
    "唐莉梅",
    "吴扬",
    "向渟",
    "司徒仕尧",
    "刘璐",
    "刘瑛",
    "樊绍光",
    "高菲",
    "李青",
    "李伟",
    "康利",
    "付懋森",
    "崔喜爱",
    "张里阳",
    "何永平",
    "陈水蓉",
    "陈婷婷",
    "李隆",
    "安侯伟",
    "马学谦",
    "赵海梅",
    "李文敏",
    "李玲",
    "唐鹏",
    "颜华亭",
    "马瑛",
    "董新新",
    "赵亮",
    "关良",
    "黄桉凡",
    "梁钧怡",
    "梁华玲",
    "李璐",
    "张少婷",
    "冯玮铃",
    "卢林冬",
    "黄凯丽",
    "郭飞燕",
    "罗凯",
    "祁绪龙",
    "温晶",
    "段永亮",
    "林冬",
    "李茂成",
    "李珊珊",
    "张金玲",
    "张琪",
    "张元刚",
    "宋叶峰",
    "孙荣华",
    "刘芳",
    "刘欢",
    "于增强",
    "张鄞",
    "李佳燕",
    "黄文勇",
    "高琪",
    "马婧",
    "韩国琳",
    "陈文",
    "金泉才",
    "郭晨希",
    "郭冬",
    "邹伟",
    "赵素琴",
    "肖姝玮",
    "红梅",
    "王海娥",
    "王浩",
    "王建敏",
    "沈瑾",
    "汤宁",
    "杨海睿",
    "李卫民",
    "李佳",
    "张玲",
    "姜月清",
    "吴兰",
    "吴传钰",
    "刘静",
    "刘萌珂",
    "刘聪",
    "刘娇",
    "刘培培",
    "于丽洁",
    "龚晓丽",
    "高玉博",
    "郑剑超",
    "薛勇",
    "田笑",
    "王瑾",
    "王晓霞",
    "焦洋",
    "梁馨月",
    "杨栩",
    "李依笑",
    "李佳泳",
    "文凤娟",
    "张艳锋",
    "张煜斌",
    "宋铁成",
    "伍海燕",
    "万昊旻",
    "高瑶",
    "闫泓",
    "卢健",
    "冉瑞奎",
    "黄诗棋",
    "高宇平",
    "韩林雨瞳",
    "陈悦",
    "邹建新",
    "贾海鹰",
    "谢杏莹",
    "袁玉",
    "袁潮",
    "蔡云",
    "蒋丹",
    "肖荟蕾",
    "章慧英",
    "王潇",
    "王永花",
    "潘恺辰",
    "正值",
    "梁惠娟",
    "杨丽慧",
    "杜莞榕",
    "李红云",
    "李杰",
    "李得勤",
    "戴瑛",
    "张岑",
    "孔铃涵",
    "周晓",
    "周小涵",
    "吴钧宇",
    "吴育锟",
    "卢静",
    "刘敏",
    "冯雪君",
    "余建锐",
    "张东琴",
    "吴延山",
    "吴然",
    "张宁",
    "周宇",
    "马楠",
    "韩璐",
    "韩涛",
    "韩嘉乐",
    "陶永新",
    "陈诗颖",
    "陈亮",
    "钟小启",
    "郑泽华",
    "邓婕",
    "祝雅思",
    "王力艳",
    "杜荣波",
    "李长培",
    "李琼",
    "曾书慧",
    "张利学",
    "张伶俐",
    "四建磊",
    "唐赟",
    
    "卢姣",
    "刘安然",
    "刘娜",
    "仇彦辉",
    "于海杰",
    "于博",
    "戴翼",
    "魏裕革",
    "饶轶",
    "邵戎",
    "赵晓妮",
    "袁永恒",
    "蒲希",
    "胡瑞卿",
    "李傲",
    "李俊",
    "曹锐怡",
    "张玲婧",
    "张武龙",
    "张格苗",
    "宋璠",
    "周秋雪",
    "吴卉",
    "刘丽欣",
    "伍清",
    "胡金敏",
    "郑泽会",
    "高远",
    "赖敏",
    "马国煦",
    "张楠",
    "王丹",
    "张娜娜",
    "丁小立",
    "李红英",
    "胡晓平",
    "马玉莲",
    "陈乃澍",
    "胡晓",
    "穆俊宇",
    "王杰",
    "张宏伟",
    "庞章军",
    
    "任俊",
    "栾菲",
    "贺冰蕊",
    "刘家辉",
    "陈志宇",
    "郭若水",
    "郭慧芳",
    "谢丽萍",
    "杨恒荣",
    "李雯",
    "朱晔",
    "文科",
    "徐嫩羽",
    "张慧迪",
    "张仁兴",
    "封隆永",
    "卢素花",
    "黄干淇",
    "黄天戈",
    "郝华宾",
    "符志军",
    "符式红",
    "章焕",
    "林正健",
    "杨少秋",
    "李鸿儒",
    "李锡成",
    "李钦",
    "李晋",
    "张滢滢",
    "张晓晨",
    "周海霞",
    "周冬梅",
    "刘伟",
    "华维光",
    "周昕南",
    "孙梓宸",
    "柏建华",
    "章晨望",
    "陈永乐",
    "龚佳娱",
    "计加成",
    "陈睿",
    "陈抒忆",
    "杜建兰",
    "徐伙",
    "段冶",
    "董灵汝",
    "刘靖楠",
    "苏慧",
    "李娇",
    "张郁",
    "马境菲",
    "韩晓",
    "韦佳伶",
    "陶永鑫",
    "金鑫",
    "过宇飞",
    "赵兔祥",
    "王靖童",
    "王敏",
    "王彬",
    "王亮",
    "次旦久美",
    "杨红梅",
    "杜娟",
    "张晓卿",
    "张晓冬",
    "崔芸嘉",
    "宁建东",
    "冯玉霞",
    "付晓玉",
    "于栋",
    "黄清瀚",
    "黄家蔚",
    "魏雪",
    "赵文",
    "甘志强",
    "王语卉",
    "梅晖晗",
    "梁恬恬",
    "林伊",
    "杨春竹",
    "杜锦平",
    "孙啸",
    "周扬",
    "刘雪晴",
    "冯箫",
    "于仕琪",
    "丹曾卓玛",
    "张晨",
    "董丽鑫",
    "黄金颖",
    "郭金海",
    "郭玲",
    "蒋建莹",
    "董颜",
    "艾雅雯",
    "白玉洁",
    "田静",
    "杨冰韵",
    "李昕翼",
    "方奎明",
    "张茜",
    "张洁",
    "张建业",
    "尹晓梅",
    "叶芳璐",
    "卢睿",
    "何长剑",
    "田君杰",
    "缪麟杰",
    "陈丽红",
    "马移铭",
    "陶亦为",
    "林利军",
    "裘珺琳",
    "夏程晟",
    "孙健",
    "尹姗",
    "王连仲",
    "鲍赫",
    "鲁畅",
    "赵娜",
    "谢玉丽",
    "蒲彦任",
    "胡学英",
    "罗澜",
    "田晨旭",
    "李菊",
    "李昕",
    "张钦",
    "张明禄",
    "夏子麟",
    "吕凡超",
    "刘雅琪",
    "刘钊",
    "乌梦达",
    "王玉生",
    "杨丹",
    "王姣姣",
    "李雁",
    "陈飘", "王婷婷", "王春竹", "王琳悦", "王琳玮", "王祯晗",
    "田宏伟", "白玉壮", "石奎", "程欣然", "程琴", "简菊芳", "罗皓文", "肖宇", "胡竞文", "蒋婷",
    "袁微", "袁迎蕾", "谭容梅", "赵子程", "赵宁", "赵晓凤", "赵欣", "赵清", "赵顺怡", "邓京勉",
    "郑鹏徽", "郭笑羽", "郭黎", "闫辰宇", "阳毅", "陈争", "陈佳雨", "陈力强", "陈思雨", "陈晓颖",
    "韩焱红", "韩靖然", "马欣", "马洵", "马美娟", "马超", "魏颖", "黄姿娜", "黄娟", "黄彬",
    "黄曙杰", "黄燕娣", "黄诗雯", "黄龙飞",
    "王翔",
    "王大鹏",
    "戴春容",
    "赖楚凡",
    "曾海媚",
    "王天巍",
    "王小粤",
    "苏杰西",
    "严培君", "严雪", "云波", "任建玲", "刘云花", "刘冠男", "刘小金", "刘康", "刘畅", "别庸",
    "史光浩", "吴彤", "吴清传", "周伶俐", "周成东", "周芳", "周蓉", "唐宇琨", "夏网萍", "孙振山",
    "孙诗明", "岳毅", "崔国辉", "廖润民", "张嘉赫", "张平", "张志强", "张曼义", "张艺博", "张艺琼",
    "张超群", "曹雪梅", "曾岚", "李中伯运", "李丽萍", "李冬梅", "李宏宇", "李欣泽", "李炳昆", "李艳芬",
    "杨帆冶", "杨泽堃", "杨莹", "林泽微", "梁健", "段昊书", "段艺萍", "沈文颖", "王万筠", "王娣",
    "王畅", "王美丽", "石美芬", "罗响", "胡扬", "蒋芷晴", "赵小兰", "赵海", "迟茜元", "邓敏佳",
    "邱迪", "高亚敏", "高静", "黄琬婷", "黄舒倩", "黎家蓉",
    "丁霖", "他文波", "付亚楠", "刘磊", "包君俏", "周弘媛", "安海涛", "朱磊磊", "李富敏", "李长生",
    "杨千慧", "杨欣洁", "熊超慧", "王小萍", "王玫", "田盼盼", "程译萱", "葛永乐", "赵旭涵", "赵继梅",
    "邓汝伊", "郝倩楠", "郭飞", "金雪", "闫妍", "陈才", "陈田凤", "随金明", "韩晨超", "黄健",
    "乔斌", "任海山", "冉阳", "刘亚丽", "刘原岳", "叶晶晶", "周信荔", "唐韬", "孙志娟", "宋水华",
    "宋茜", "徐方姝", "徐晨蕾", "方子轩", "施思", "曲原", "曹红祖", "朱延爱", "李文奕", "李晓荣",
    "李甫", "杨久平", "杨郭程", "樊洁馨", "毛明红", "牟德宏", "王兴环", "王兵", "王庆语", "索长利",
    "郑玮华", "钱浩", "阿布力克木·艾合买提尼亚孜", "陈天宇", "陈子祎", "陈思宇",
    "丁兮", "付廷加", "兰海林", "吴永斌", "孙琪", "孙蕾", "庄嘉", "张立生", "徐梓力", "李洋",
    "林晓东", "王华伟", "王向", "王寅娟", "王寿辉", "王秀荣", "王维国", "王莉萍", "祁宁", "米卫红",
    "蒋曼", "蔡亮", "虞佳姣", "虞建飞", "谢伦胜", "赵刚", "赵雨薇", "郭海燕", "钟燕川", "陈慧雯",
    "陈懿妮", "马晓青", "黄亿", "黄颖",
    "冯浩", "刘根强", "刘礼锋", "唐雅丽", "夏瑞", "姚婧", "庄若南", "张文言", "张旭", "张莹",
    "方思达", "朱姣", "李晓蝶", "杨普平", "杨晶", "梁静", "段娟", "段宸宇", "汪小鹏", "王双正",
    "王晓南", "田涛", "章威", "肖湘", "许素乾", "谢蕾", "闫明明", "雷宇", "顾宇", "黄哲",
    "吕晨", "毕靖钰", "程薛娇", "吴岚", "那仁图雅", "刘春泉", "刘俊", "陈声超", "陈圣劼", "陈月梅", "张怡歌", "张乐飞", "赵晓琳", "郝佳瑾", "贾振国", "朱晓东", "朱自强", "魏亮",
    "于明洋", "刘春兰", "叶天", "周积强", "季燕珊", "张延宾", "张运国", "徐岩", "星寅聪", "李丹", "李光涛", "李彬", "杨开围", "段宇辉", "汤秋怡", "沈杨雁", "王亚东", "王梅娟", "王汉堃", "王涛", "瞿杨生", "邓燕楠", "郭鹏", "韩雪婷", "马玉芳",
    "严璋",
    "党张利",
    "凌晶",
    "姜钧藐",
    "孟冉冉",
    "崔滨镜",
    "曹经福",
    "李岩涛",
    "李琳",
    "杨晓娟",
    "沈文慧",
    "王慧君",
    "王立山",
    "程镜戎",
    "胡照锁",
    "胡田田",
    "莫申萍",
    "许天骄",
    "贺赟",
    "赵柳双",
    "辛悦",
    "郭彬",
    "郭春燕",
    "陈振林",
    "鞠晓慧",
    # 20260819 新增（审核确认）
    "付叶贞", "余佳", "余昌波", "冀涛", "周秉荣", "孙怀珍", "张冰清", "张炎",
    "曹丽霞", "曹晓云", "曹颖", "杨亦萍", "武雅丽", "焦瑛", "王凌梓", "秦采薇",
    "袁帅", "贾亚飞", "郭亚琦", "金瑛", "陈梅", "齐红",

}

# 姓氏先验：库内已知名首字频率（大姓如王李张刘陈频率高 → 更可信）
SURNAME_FREQ = {}
for _a in KNOWN_AUTHORS:
    if _a:
        SURNAME_FREQ[_a[0]] = SURNAME_FREQ.get(_a[0], 0) + 1


def month_day(date_str):
    return f"{date_str[4:6]}月{date_str[6:8]}日"


# ===== 工具函数 =====

def curl_post(url, data):
    r = subprocess.run(
        ["curl", "-s", "-X", "POST", "--connect-timeout", "5", "--max-time", "15", url, "-d", data],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20
    )
    if r.returncode != 0: return None
    try:
        return json.loads(r.stdout)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def clean_html(text):
    text = text.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    text = text.replace("&ldquo;", "\u201c").replace("&rdquo;", "\u201d").replace("&mdash;", "\u2014")
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r" {3,}", "  ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def fm_list(key, value, splitter=None):
    """把字段值写成 YAML 块式 list（单值也写成 list）。空值保持 `key: `。"""
    if not value:
        return f"{key}: "
    if splitter:
        items = [v.strip() for v in re.split(splitter, value) if v.strip()]
    elif isinstance(value, str):
        items = [v for v in value.split() if v.strip()]
    else:
        items = [str(v).strip() for v in value if str(v).strip()]
    if not items:
        return f"{key}: "
    return "\n".join([f"{key}:"] + [f"  - {v}" for v in items])


def _anchor_segments(part):
    """在 part 中定位所有库内已知名（非重叠、覆盖最大化、每位置最长优先）。

    返回 [(start, end, name)]。库内名字整体保留，绝不被后续启发式破坏。
    """
    n = len(part)
    hits = [[] for _ in range(n)]
    for i in range(n):
        for length in (4, 3, 2):
            if i + length <= n and part[i:i + length] in KNOWN_AUTHORS:
                hits[i].append((length, part[i:i + length]))
        # 带·少数民族长名（如 阿布力克木·艾合买提尼亚孜）：遍历库内含·名做全文匹配
        if '·' in part:
            for _name in KNOWN_AUTHORS:
                if '·' in _name:
                    _idx = part.find(_name)
                    if _idx != -1:
                        hits[_idx].append((len(_name), _name))
        # 锚点后剩余 1 字（如 王晓 南）无法成段：该锚点是误命中，不选
        for _i in range(n - 1):
            hits[_i] = [h for h in hits[_i] if _i + h[0] != n - 1]
    best = [0] * (n + 1)
    choice = [None] * n
    for i in range(n - 1, -1, -1):
        opt = best[i + 1]
        pick = None
        for length, name in hits[i]:
            cand = length + best[i + length]
            if cand > opt:
                opt = cand
                pick = (length, name)
        best[i] = opt
        choice[i] = pick
    segs = []
    i = 0
    while i < n:
        if choice[i] is None:
            j = i + 1
            while j < n and choice[j] is None:
                j += 1
            segs.append((i, j, None))
            i = j
        else:
            length, name = choice[i]
            segs.append((i, i + length, name))
            i += length
    return segs


def _surname_bonus(ch):
    """段首字作为姓氏的先验加分：库内高频姓（≥5 人）更可信 → +2"""
    return 2 if SURNAME_FREQ.get(ch, 0) >= 5 else 0


def _split_unknown(seg):
    """启发式切分未知段（库内无锚点）：每段 2-3 字、段首须为常见姓，
    3 字段优先（长度平方和评分）+ 姓氏先验加成，首字非姓时低分保留交人工/LLM。"""
    n = len(seg)
    if n <= 3:
        return [seg]
    if n == 4:
        if seg[0] in SURNAMES and seg[2] in SURNAMES:
            return [seg[:2], seg[2:]]
        return [seg]
    cache = {}

    def dp(i):
        if i in cache:
            return cache[i]
        if i >= n:
            cache[i] = (0, [[]])
            return cache[i]
        if n - i < 2:  # 剩余 1 字无法成段 → 无解
            cache[i] = (None, [])
            return cache[i]
        best = -1
        sols = []

        def add(score, cand):
            nonlocal best
            if score > best:
                best = score
                sols.clear()
                sols.append(cand)
            elif score == best:
                sols.append(cand)

        # 3 字段（得分 9 = 3²，+ 姓氏先验）
        if seg[i] in SURNAMES and i + 3 <= n:
            sc, subs = dp(i + 3)
            if sc is not None:
                for sub in subs:
                    add(sc + 9 + _surname_bonus(seg[i]), [seg[i:i + 3]] + sub)
        # 2 字段（得分 4 = 2²，+ 姓氏先验）
        if seg[i] in SURNAMES and i + 2 <= n:
            sc, subs = dp(i + 2)
            if sc is not None:
                for sub in subs:
                    add(sc + 4 + _surname_bonus(seg[i]), [seg[i:i + 2]] + sub)
        # 兜底：首字非姓 → 整体保留（低分 1，交人工/LLM 复核）
        if seg[i] not in SURNAMES:
            add(1, [seg[i:]])
        cache[i] = (best, sols)
        return cache[i]

    best, sols = dp(0)
    if not sols:
        sols = [[seg]]
    if len(sols) > 1:
        print(f"  ⚠ 未知作者串歧义: [{seg}] 候选: {' | '.join('/'.join(s) for s in sols)}（取第一种，请人工复核）", file=sys.stderr)
    return sols[0]


def split_authors(author):
    if not author:
        return author
    parts = re.split(r'[\s,，、]+', author)
    result = []
    for part in parts:
        if not part:
            continue
        if len(part) <= 2:
            result.append(part)
            continue
        # 阶段1：锚点钉住——库内已知名整体保留（DP 最大覆盖）
        anchored = _anchor_segments(part)
        unknown_part = ''.join(part[s:e] for s, e, n in anchored if n is None)
        if '·' in unknown_part:
            # 带·名未入库：无法可靠切分，整段保留交人工（不切碎）
            print(f"  ⚠ 带·名字需人工确认: {part}", file=sys.stderr)
            result.append(part)
            continue
        segs = []
        for (s, e, name) in anchored:
            if name is not None:
                segs.append(name)
            else:
                segs.extend(_split_unknown(part[s:e]))
        result.append(' '.join(segs))
    return ' '.join(result)


def extract_region(title, body):
    for k, v in CITY_REGION.items():
        if k in title: return v
    for k, v in sorted(CITY_REGION.items(), key=lambda x: -len(x[0])):
        if k in body[:200] and v: return v
    return ""


def html_clean(s):
    """清理 HTML 实体和标签"""
    from html import unescape
    s = unescape(s)
    # 双重编码残留（&amp;nbsp;→&nbsp;）或实体转 \xa0：统一为空格
    s = s.replace("&nbsp;", " ").replace("\xa0", " ")
    return re.sub(r"<[^>]+>", "", s).strip()

def sanitize_filename(s):
    return re.sub(r'[\\/:*?"<>|]', '', s)[:80]



def extract_region(title, body):
    """region 由 enrich_regions.py (LLM) 处理，此处留空。"""
    return ""


def edition_type(theme):
    return "常规版" if theme in REGULAR_THEMES else "策划版"


def page_label(bc):
    return {"01": "一版", "02": "二版", "03": "三版", "04": "四版"}.get(bc, f"第{bc}版")


def month_day(ymd):
    return f"{ymd[4:6]}月{ymd[6:8]}日"


# ===== 主流程 =====

def process_article(data, page_name, order, date_str, out_dir, theme, subtitle="", existing_col="", existing_region=""):
    """核心：处理一篇稿件（清洗内容、提取作者、写文件）。单稿和批量都走这里。"""
    from html import unescape
    content_raw = data.get("content", "")
    content_text = unescape(re.sub(r"<br\s*/?>", "\n", content_raw, flags=re.I))
    content_text = re.sub(r"<[^>]+>", "", content_text)
    content_text = re.sub(r"\n{3,}", "\n\n", content_text).strip()
    title = html_clean(str(data.get("docTitle") or ""))
    final_title = title.split("——")[0].strip() if "——" in title else title
    is_pic = (final_title == "图片新闻") or (len(content_text.split("\n")) < 3 and len(content_text) < 80)
    # 无标题（docTitle 为 null/"null"/空，多为图片新闻）：从正文首行/CS 提取，兑底"图片新闻"
    if not final_title or final_title.lower() == "null":
        lines = [l.strip() for l in content_text.split("\n") if l.strip()]
        first = re.sub(r'^[◀▼▶▲◆]\s*', '', lines[0]) if lines else ""
        if first and not first.startswith(("图为", "图片说明")):
            final_title = first[:30]
        elif data.get("CS", ""):
            final_title = re.sub(r'^[◀▼▶▲◆]\s*', '', str(data.get("CS")).split(";")[0].strip())[:30]
        else:
            final_title = "图片新闻"
        is_pic = True

    # 作者处理 (略去 简报拆分 等批量特有逻辑)
    author = ""
    doc_author = data.get("docAuthor", "")
    if doc_author:
        author = re.sub(r'^(新华社|本报)(特约)?(记者|通\s*讯\s*员)?\s*', '', doc_author).strip()
        author = re.sub(r'《[^》]+》记者[\u4e00-\u9fff]{2,4}\s*', '', author).strip()
        author = re.sub(r'《[^》]+》', '', author).strip()
        if re.search(r'[上下]转', author): author = ""
        # 清理作者串中残留的职称（正文提取路径已做，docAuthor 路径也要做）
        # 不依赖空格边界："实习记者""特约记者"等胶连职称也清除
        author = re.sub(r'(?:实习|特约)?\s*(?:记者|通\s*讯\s*员)\s*', ' ', author).strip()
        author = re.sub(r'(?:实习|特约)?(?:记者|通\s*讯\s*员|评论员)\s*$', '', author).strip()
        author = re.sub(r'^来源[：:][^，。]*?编译[：:]\s*', '', author).strip()
        # 尾部"报道/近日/连日来"等正文词：不依赖空格边界（如"刘雅琪报道近日"）
        author = re.sub(r'(?:报道|文|图)?\s*(?:受|连日来|近日|日前|随着|面对|今年|截至|目前|正值|汛期)\s*$', '', author).strip()
        author = re.sub(r'(?:报道|文|图)\s*$', '', author).strip()
    # 正文开头署名提取：docAuthor 非空也执行，合并去重（API 可能漏记者/通讯员）
    _lead = ""
    _m2 = re.search(r'(?:本报讯|本报)\s*(?:记者|通\s*讯\s*员|特约记者|特约通讯员|实习记者)\s*([\u4e00-\u9fff· ]+?)(?:\s*报道|，|\n)', content_text[:300])
    if not _m2:
        _m2 = re.search(r'(?:本报讯|本报)\s*(?:记者|通\s*讯\s*员|特约记者|特约通讯员|实习记者)?\s*([\u4e00-\u9fff· ]+)', content_text[:200])
    if _m2:
        _lead = re.sub(r'\s+', ' ', _m2.group(1).strip())
        _lead = re.sub(r'\s*(?:记者|通\s*讯\s*员|特约记者|特约通讯员|实习记者)\s*', ' ', _lead).strip()
        _lead = re.sub(r'(?:记者|通\s*讯\s*员|特约记者|特约通讯员|实习记者|评论员)\s*$', '', _lead).strip()
        _lead = re.sub(r'^来源[：:][^，。]*?编译[：:]\s*', '', _lead).strip()
        if re.search(r'^(本报\s*)?(评论员|记者|通\s*讯\s*员|特约记者|特约通讯员|实习记者)\s*$', _lead):
            _lead = ""
        _lead = re.sub(r'\s+(受|连日来|近日|日前|随着|面对|今年|今年第|今年以来|截至|目前|正值|汛期|编者按|最近|超长|连日|眼下|当前|进入)\s*$', '', _lead).strip()
        _lead = re.sub(r'\s+第\d+号?\s*$', '', _lead).strip()
    if _lead:
        # 胶连多名（无空格，如“李红梅李岩涛郭春燕”）先用锚点法分词再校验
        if len(_lead.replace(' ', '')) > 4:
            _lead = split_authors(_lead)
        # 人名校验：每段须为 2-4 字且首字是常见姓氏或已入库；否则 LEAD 不可靠，宁缺勿错（走文末/人工）
        _segs = _lead.split()
        if not (all(2 <= len(s) <= 4 for s in _segs) and all(s in KNOWN_AUTHORS or s[0] in SURNAMES for s in _segs)):
            _lead = ""
    if _lead:
        # docAuthor 胶连名先分词，避免与正文署名合并时重复（如“冀涛段宸宇贾亚飞”+正文同名）
        if author and len(author.replace(' ', '')) > 4:
            author = split_authors(author)
        _names = author.split() if author else []
        for _n in _lead.split():
            if _n and _n not in _names:
                _names.append(_n)
        author = ' '.join(_names)
    if not author:
        m = re.search(r'（([^）]+整理)）\s*$', content_text)
        if m: author = re.sub(r'整理\s*$', '', m.group(1)).strip()
        if not m: m = re.search(r'（编译[：:]\s*([\u4e00-\u9fff·、]+?)(?:来源|[）)]|$)', content_text)
        if m and not author: author = m.group(1).strip()
        if not m: m = re.search(r'（来源[：:][^）]*?编译[：:]\s*([\u4e00-\u9fff·、]+)', content_text)
        if not m: m = re.search(r'（([\u4e00-\u9fff·\s]{2,}?)）\s*$', content_text, re.MULTILINE)
        if m and not author:
            candidate = re.sub(r'\s+', ' ', m.group(1)).strip()
            # 职务/说明性括号（"作者系…副县长"等）不是署名
            if not re.search(r'(?:作者)?系|担任|职务|记者|通\s*讯\s*员|副县长|县长|局长|部长|书记|主任', candidate):
                author = candidate
        if not m: m = re.search(r'（(?:调研组成员?|作者)[：:]\s*([\u4e00-\u9fff·、]+)）', content_text)
        if m and not author: author = ' '.join(n.strip() for n in re.split(r'[、，,]', m.group(1)) if n.strip())
        if not m:
            pa = re.findall(r'(?:图|文|制图)[/:]\s*([\u4e00-\u9fff·]{2,4}?)(?=(?:文|图|制图)/|\n|$)', content_text, re.MULTILINE)
            if pa: author = ' '.join(dict.fromkeys(
                re.sub(r'^文', '', n).strip() for n in pa if re.sub(r'^文', '', n).strip()
            ))
            # 仅标"本报评论员"无实际作者时清空
            if not author and re.search(r'^本报评论员', content_text[:30]) and not re.search(r'本报(记者|通\s*讯\s*员)', content_text[:30]): author = ""
            author = re.sub(r'\s+(受|连日来|近日|日前|随着|面对|今年|截至|目前|正值|汛期)\s*$', '', author).strip()
    if not author:
        fl = content_text.split("\n")[0].strip()
        if fl and 2 <= len(fl) <= 4 and not re.match(r'^(本报讯|本报|新华社|图为|编者)', fl):
            author = split_authors(fl)
    if author.lower() in ("null", "none"):
        author = ""
    author = split_authors(author)

    ed_type = edition_type(theme)
    # 地区提取
    region = extract_region(final_title, content_text[:1500]) if not existing_region else existing_region
    region = existing_region or region
    
    fm = ["---", "type: 报道", "source: 中国气象报",
          f"title: {final_title}", fm_list("author", author),
          f"date: {date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}", f"page: {page_name}",
          f"theme: {theme}", f"edition_type: {ed_type}",
          f"headline: {'true' if order==1 else 'false'}"]
    if is_pic: fm.append("image: true")
    if subtitle: fm.append(f"subtitle: {subtitle}")
    if existing_col: fm.append(fm_list("column", existing_col))
    else: fm.append("column: ")
    fm.append(fm_list("region", region, splitter=r"[,，;；]"))
    fm.append("---")
    md = "\n".join(fm) + "\n\n" + content_text + "\n"
    fname = f"{order:02d}-{sanitize_filename(final_title)}.md"
    page_dir = os.path.join(out_dir, page_name)
    os.makedirs(page_dir, exist_ok=True)
    with open(os.path.join(page_dir, fname), "w", encoding="utf-8") as f:
        f.write(md)
    return fname, region


def fetch_single(guid, date_str):
    """按 GUID 单篇重抓：找版次→获取全文→process_article。"""
    out_dir = month_dir(date_str)
    os.makedirs(out_dir, exist_ok=True)
    date_dash = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    editions_data = curl_post(f"{API_BASE}/findBmMenu.do", f"docPubTime={date_str}")
    if not editions_data:
        print(f"错误: 无法获取 {date_str} 版面列表"); sys.exit(1)
    page_info = {}
    for ed in editions_data:
        for bc, info in ed.get("CS", {}).items():
            if isinstance(info, dict) and info.get("lmn"):
                page_info[bc] = info["lmn"]
    for bc in ["01","02","03","04"]:
        articles = None
        for attempt in range(3):
            articles = curl_post(f"{API_BASE}/getBmDetail.do", f"bc={bc}&docpubtime={date_dash}")
            if articles: break
            time.sleep(2 if attempt < 2 else 5)
        if not articles: continue
        for i, a in enumerate(articles):
            if a["ZB_GUID"] != guid: continue
            data = curl_post(f"{API_BASE}/detailData.do", f"guid={guid}")
            if not data:
                print(f"  错误: GUID={guid} 获取全文失败"); sys.exit(1)
            theme = page_info.get(bc, {"01":"要闻","02":"综合","03":"科技","04":"科普"}.get(bc, ""))
            fname, region = process_article(data, page_label(bc), i+1, date_str, out_dir, theme)
            print(f"  {page_label(bc)} {i+1:02d} 已重抓: {fname}")
            return
    print(f"  错误: GUID={guid} 未在 {date_str} 任何版面找到"); sys.exit(1)

def batch_fetch(date_str):
    """并行批量抓取：先获取各版列表去重，再并行拉取每篇稿件。"""
    out_dir = month_dir(date_str)
    os.makedirs(out_dir, exist_ok=True)
    date_dash = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    
    # Step 1: 获取各版文章列表
    editions_data = curl_post(f"{API_BASE}/findBmMenu.do", f"docPubTime={date_str}")
    if not editions_data:
        print(f"错误: 无法获取 {date_str} 版面列表"); sys.exit(1)
    page_info = {}
    for ed in editions_data:
        for bc, info in ed.get("CS", {}).items():
            if isinstance(info, dict) and info.get("lmn"):
                page_info[bc] = {"page": page_label(bc), "theme": info["lmn"]}
    
    all_articles = []
    for bc in ["01","02","03","04"]:
        articles = None
        for attempt in range(3):
            articles = curl_post(f"{API_BASE}/getBmDetail.do", f"bc={bc}&docpubtime={date_dash}")
            if articles: break
            time.sleep(2 if attempt < 2 else 5)
        if not articles:
            print(f"  ⚠ 无法获取 {page_label(bc)} 文章列表"); continue
        for i, a in enumerate(articles):
            all_articles.append({
                "guid": a["ZB_GUID"], "title": a["DOCTITLE"], 
                "bc": bc, "order": i+1
            })
    
    # Step 2: 去重
    seen = set()
    unique = []
    for a in all_articles:
        if a["title"] not in seen:
            seen.add(a["title"])
            unique.append(a)
    
    print(f"共 {len(unique)} 篇（去重后），并行拉取...")
    lock = threading.Lock()
    success = 0
    
    def fetch_one(a):
        nonlocal success
        guid = a["guid"]
        bc = a["bc"]
        data = None
        for attempt in range(3):
            data = curl_post(f"{API_BASE}/detailData.do", f"guid={guid}")
            if data: break
            time.sleep(2 if attempt < 2 else 5)
        if not data:
            print(f"  错误: GUID={guid} 获取全文失败"); sys.exit(1)
        theme = page_info.get(bc, {}).get("theme", {"01":"要闻","02":"综合","03":"科技","04":"科普"}.get(bc, ""))
        page = page_label(bc)
        with lock:
            fname, region = process_article(data, page, a["order"], date_str, out_dir, theme)
            hl = "★" if a["order"] == 1 else " "
            print(f"  {page} {a['order']:02d}{hl} {fname.split('-',1)[1][:35]}  reg={region}")
            success += 1

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        list(ex.map(fetch_one, unique))
    
    print(f"\n完成: {success} 篇文章 -> {out_dir}")

def main(date_str):
    out_dir = month_dir(date_str)
    os.makedirs(out_dir, exist_ok=True)

    # Step 1: 获取版面列表
    editions_data = curl_post(f"{API_BASE}/findBmMenu.do", f"docPubTime={date_str}")
    if not editions_data:
        print(f"错误: 无法获取 {date_str} 版面列表")
        sys.exit(1)

    print(f"共 {len(editions_data)} 个版面")
    
    pages = []
    for ed in editions_data:
        bc = ed["IRCATELOG"]
        theme = ed["BM"]
        jppath = ed.get("JPPATH", "")
        page = page_label(bc)
        pages.append({
            "bc": bc, "page": page, "theme": theme, "jppath": jppath,
            "articles": []
        })
        print(f"  {page} ({theme})")

    # Step 2: 获取各版文章列表
    date_dash = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    for p in pages:
        articles = curl_post(f"{API_BASE}/getBmDetail.do", f"bc={p['bc']}&docpubtime={date_dash}")
        if not articles:
            print(f"  错误: 无法获取 {p['page']} 文章列表，终止抓取")
            sys.exit(1)
        for a in articles:
            p["articles"].append({
                "guid": a["ZB_GUID"],
                "title_api": a.get("DOCTITLE", ""),
                "author_hint": a.get("DOCAUTHOR", ""),
                "words": a.get("TXS", "0"),
            })

    # Step 3: 去重 (同标题只保留靠前版次)
    seen_titles = set()
    for p in pages:
        kept = []
        for a in p["articles"]:
            if a["title_api"] in seen_titles:
                print(f"  去重 {p['page']}: '{a['title_api'][:30]}'")
                continue
            seen_titles.add(a["title_api"])
            kept.append(a)
        p["articles"] = kept

    # Step 4: 获取全文
    all_guids = set()
    for p in pages:
        for a in p["articles"]:
            all_guids.add(a["guid"])
    print(f"\n获取 {len(all_guids)} 篇文章全文...")

    api_data = {}
    failed = 0
    for g in sorted(all_guids):
        data = None
        for attempt in range(3):
            data = curl_post(f"{API_BASE}/detailData.do", f"guid={g}")
            if data:
                break
            print(f"    重试第{attempt+1}次... GUID={g}")
            time.sleep(2 if attempt < 2 else 5)
        if data:
            api_data[g] = data
        else:
            failed += 1
        time.sleep(0.15)
    if failed:
        print(f"  错误: {failed} 篇文章获取全文失败，终止抓取。请重试")
        sys.exit(1)
    print(f"成功获取 {len(api_data)} 篇")

    # Step 5: 生成 Markdown 文件
    total = 0
    for p in pages:
        page = p["page"]
        theme = p["theme"]
        ed_type = edition_type(theme)
        page_dir = os.path.join(out_dir, page)
        os.makedirs(page_dir, exist_ok=True)

        for idx, a in enumerate(p["articles"]):
            guid = a["guid"]
            data = api_data.get(guid)
            if not data: continue

            order = idx + 1
            title = (data.get("docTitle", "") or "").strip() or a["title_api"]
            subtitle = data.get("fb", "")
            content_raw = data.get("content", "")
            content_text = clean_html(content_raw)

            # 图片新闻判定
            is_pic = False
            pic_title = ""
            # API 标题为"图片新闻"则强制视为图片新闻
            if title == "图片新闻" or not title or title.lower() in ("null", "none"):
                is_pic = True
                cs_parts = [p.strip() for p in str(data.get("CS") or "").split(";") if p.strip() and p.strip().lower() != "null"]
                lines = [l.strip() for l in content_text.split("\n") if l.strip()]
                if lines:
                    first = re.sub(r'^[◀▼▶▲◆]\s*', '', lines[0])
                    pic_title = first[:30]
                elif cs_parts:
                    content_text = "\n".join(cs_parts)
                    pic_title = re.sub(r'^[◀▼▶▲◆]\s*', '', cs_parts[0])[:30]
                if not pic_title:
                    pic_title = "图片新闻"
            elif content_raw:
                lines = [l.strip() for l in content_text.split("\n") if l.strip()]
                cs_parts = [p.strip() for p in str(data.get("CS") or "").split(";") if p.strip() and p.strip().lower() != "null"]
                if not lines and cs_parts:
                    content_text = "\n".join(cs_parts)
                    first = re.sub(r'^[◀▼▶▲◆]\s*', '', cs_parts[0])
                    pic_title = first[:30]
                    is_pic = True
                elif len(lines) <= 3 and all(len(l) < 60 for l in lines):
                    first = re.sub(r'^[◀▼▶▲◆]\s*', '', lines[0]) if lines else "图片新闻"
                    pic_title = first[:30]
                    is_pic = True

            final_title = pic_title if is_pic else title

            # 要闻简报拆分：正文含多条"本报讯"的合并简报按条拆分
            if "要闻简报" in final_title and content_text.count("本报讯") > 1:
                items = re.split(r'(?=本报讯)', content_text)
                items = [i.strip() for i in items if i.strip()]
                if len(items) > 1:
                    # 检查哪些条目已存在独立稿件
                    existing_bodies = set()
                    for _a in p["articles"]:
                        if _a["guid"] == guid: continue  # 跳过自身
                        _d = api_data.get(_a["guid"])
                        if _d:
                            _body = clean_html(_d.get("content", ""))[:50]
                            existing_bodies.add(_body)
                    
                    kept_items = []
                    for item in items:
                        # 跳过与独立稿件重复的条目
                        if item[:50] in existing_bodies:
                            continue
                        kept_items.append(item)
                    
                    if kept_items:
                        # 为每个条目生成单独文件
                        for ki, item in enumerate(kept_items):
                            # 从正文提取标题（取前20字）
                            item_title = re.sub(r'^本报讯\s*', '', item)[:25]
                            item_title = re.sub(r'[（(][^）)]*[）)]\s*$', '', item_title).strip()
                            if not item_title:
                                item_title = f"要闻简报{ki+1}"
                            
                            item_author = ""
                            m = re.search(r'[（(]([^）)]+)[）)]\s*$', item)
                            if m:
                                item_author = split_authors(m.group(1))
                            
                            item_order = f"{order:02d}-{ki+1}"
                            item_region = extract_region(item_title, item[:100])
                            
                            item_fm = [
                                "---", "type: 报道", "source: 中国气象报",
                                f"title: {item_title}", fm_list("author", item_author),
                                f"date: {date_dash}", f"page: {page}",
                                f"theme: {theme}", f"edition_type: {ed_type}",
                                "headline: false", fm_list("column", "要闻简报"),
                                fm_list("region", item_region, splitter=r"[,，;；]"),
                                "---",
                            ]
                            item_md = "\n".join(item_fm) + "\n\n" + item + "\n"
                            item_name = f"{item_order}-{sanitize_filename(item_title)}.md"
                            item_path = os.path.join(page_dir, item_name)
                            with open(item_path, "w", encoding="utf-8") as _f:
                                _f.write(item_md)
                            total += 1
                            print(f"  {page} {item_order} {item_title[:30]} 简报拆分")
                        # 跳过合并文件的生成
                        continue

            # 作者处理
            author = ""
            doc_author = data.get("docAuthor", "")
            if doc_author:
                author = re.sub(r'^(新华社|本报)(特约)?(记者|通\s*讯\s*员)?\s*', '', doc_author).strip()
                # 去掉其他媒体记者，如《中国应急管理报》记者张三
                author = re.sub(r'《[^》]+》记者[\u4e00-\u9fff]{2,4}\s*', '', author).strip()
                # 去掉残留的《》内容
                author = re.sub(r'《[^》]+》', '', author).strip()
                # "下转第三版"/"上接第一版"等排版信息不是作者
                if re.search(r'[上下]转', author):
                    author = ""
            # 正文开头署名提取：docAuthor 非空也执行，合并去重（API 可能漏记者/通讯员）
            _lead = ""
            _m2 = re.search(r'(?:本报讯|本报)\s*(?:记者|通\s*讯\s*员|特约记者|特约通讯员|实习记者)\s*([\u4e00-\u9fff· ]+?)(?:\s*报道|，|\n)', content_text[:300])
            if not _m2:
                _m2 = re.search(r'(?:本报讯|本报)\s*(?:记者|通\s*讯\s*员|特约记者|特约通讯员|实习记者)?\s*([\u4e00-\u9fff· ]+)', content_text[:200])
            if _m2:
                _lead = re.sub(r'\s+', ' ', _m2.group(1).strip())
                _lead = re.sub(r'\s*(?:记者|通\s*讯\s*员|特约记者|特约通讯员|实习记者)\s*', ' ', _lead).strip()
                _lead = re.sub(r'(?:记者|通\s*讯\s*员|特约记者|特约通讯员|实习记者|评论员)\s*$', '', _lead).strip()
                _lead = re.sub(r'^来源[：:][^，。]*?编译[：:]\s*', '', _lead).strip()
                if re.search(r'^(本报\s*)?(评论员|记者|通\s*讯\s*员|特约记者|特约通讯员|实习记者)\s*$', _lead):
                    _lead = ""
                _lead = re.sub(r'\s+(受|连日来|近日|日前|随着|面对|今年|今年第|今年以来|截至|目前|正值|汛期|编者按|最近|超长|连日|眼下|当前|进入)\s*$', '', _lead).strip()
            _lead = re.sub(r'\s+第\d+号?\s*$', '', _lead).strip()
            if _lead:
                # 胶连多名（无空格，如“王彬乔斌曹晓云周秉荣”）先用锚点法分词再校验（与单篇路径对齐）
                if len(_lead.replace(' ', '')) > 4:
                    _lead = split_authors(_lead)
                # 人名校验：每段须为 2-4 字且首字是常见姓氏或已入库；否则 LEAD 不可靠，宁缺勿错（走文末/人工）
                _segs = _lead.split()
                if not (all(2 <= len(s) <= 4 for s in _segs) and all(s in KNOWN_AUTHORS or s[0] in SURNAMES for s in _segs)):
                    _lead = ""
            if _lead:
                # docAuthor 胶连名先分词，避免与正文署名合并时重复（如“冀涛段宸宇贾亚飞”+正文同名）
                if author and len(author.replace(' ', '')) > 4:
                    author = split_authors(author)
                _names = author.split() if author else []
                for _n in _lead.split():
                    if _n and _n not in _names:
                        _names.append(_n)
                author = ' '.join(_names)
            if not author:
                # 尝试从正文末尾提取(整理)或(XX)
                m = re.search(r'（([^）]+整理)）\s*$', content_text)
                if m: author = re.sub(r'整理\s*$', '', m.group(1)).strip()
                if not m:
                    m = re.search(r'（编译[：:]\s*([\u4e00-\u9fff·、]+?)(?:来源|[）)]|$)', content_text)
                if m and not author: author = m.group(1).strip()
                if not m:
                    m = re.search(r'（来源[：:][^）]*?编译[：:]\s*([\u4e00-\u9fff·、]+)', content_text)
                if m and not author: author = m.group(1).strip()
                if not m:
                    m = re.search(r'（([\u4e00-\u9fff·]{2,})）\s*$', content_text, re.MULTILINE)
                if m and not author: author = m.group(1).strip()
                if not m:
                    # 图片新闻署名：提取全部 图/XX 作者（可能有多个）
                    all_photo_authors = re.findall(r'(?:图|文|制图)[/:]\s*([\u4e00-\u9fff·]{2,4}?)(?=(?:文|图|制图)/|\n|$)', content_text, re.MULTILINE)
                    if all_photo_authors:
                        # 过滤掉"文"前缀（如图/文XX中"文"被当名字捕获）
                        author = ' '.join(dict.fromkeys(
                            re.sub(r'^文', '', n).strip() for n in all_photo_authors if re.sub(r'^文', '', n).strip()
                        ))  # 去重保留顺序
            # 最后兜底：正文首行单独成段的姓名
            if not author:
                first_line = content_text.split("\n")[0].strip()
                if first_line and len(first_line) >= 2 and len(first_line) <= 4:
                    # 检查是否是作者名（首行是姓名，后面是正文）
                    if not re.match(r'^(本报讯|本报|新华社|图为|编者)', first_line):
                        author = split_authors(first_line)
            # 用姓氏启发式分割粘连的多作者名
            if author.lower() in ("null", "none"):
                author = ""
            author = split_authors(author)

            is_headline = (order == 1)  # 默认每版首篇为头条，有误再改

            # 构建 frontmatter
            fm = [
                "---",
                "type: 报道",
                "source: 中国气象报",
                f"title: {final_title}",
                fm_list("author", author),
                f"date: {date_dash}",
                f"page: {page}",
                f"theme: {theme}",
                f"edition_type: {ed_type}",
                f"headline: {'true' if is_headline else 'false'}",
            ]
            if is_pic:
                fm.append("image: true")
            # column：规则推断 + 已有值保留
            col = ""
            existing_path = os.path.join(page_dir, f"{order:02d}-{sanitize_filename(final_title)}.md")
            if os.path.exists(existing_path):
                with open(existing_path, "r", encoding="utf-8") as _ef:
                    for _line in _ef:
                        if _line.startswith("column:"):
                            col = _line.split(":", 1)[1].strip()
                            break
            if not col:
                # column 留空，后续由 vision 分析补充
                pass
            fm.append(fm_list("column", col))
            # region：如果文件已存在且有值则保留，否则自动提取
            region = extract_region(final_title, content_text)
            # 图片新闻/图说不标地区
            if is_pic:
                region = ""
            # 国家领导人/党中央等全国性文章强制清空 region
            if re.search(r'^(习近平|党中央|国务院|全国两会|十四届全国)', final_title):
                region = ""
            if os.path.exists(existing_path):
                with open(existing_path, "r", encoding="utf-8") as _ef:
                    for _line in _ef:
                        if _line.startswith("region:"):
                            _old_r = _line.split(":", 1)[1].strip()
                            if _old_r:
                                region = _old_r
                            break
            fm.append(fm_list("region", region, splitter=r"[,，;；]"))
            if subtitle:
                fm.append(f"subtitle: {subtitle}")
            fm.append("---")

            md = "\n".join(fm) + "\n\n" + content_text + "\n"
            fname = f"{order:02d}-{sanitize_filename(final_title)}.md"
            fpath = os.path.join(page_dir, fname)
            with open(fpath, "w", encoding="utf-8") as f:
                f.write(md)
            total += 1
            hl = "★" if is_headline else " "
            print(f"  {page} {order:02d}{hl} {final_title[:35]}  reg={region}")

        # 版面概览 (已移除，如有需要由人工补充)
        pass

    print(f"\n完成: {total} 篇文章 -> {out_dir}")
    # 校验：期望文件数 vs 实际写入数
    expected = len(all_guids)
    if total != expected:
        print(f"  ⚠ 应有 {expected} 篇，实际写入 {total} 篇（缺失 {expected - total} 篇）")
    print("后续: 运行 vision_analyze 识别栏目/头条后修正")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python3 fetch_epaper.py YYYYMMDD")
        print("      python3 fetch_epaper.py --guid=XXXXX YYYYMMDD  # 单篇重抓")
        sys.exit(1)
    if sys.argv[1].startswith("--guid="):
        guid = sys.argv[1].split("=", 1)[1]
        date_str = sys.argv[2]
        fetch_single(guid, date_str)
    elif sys.argv[1] == "--batch":
        date_str = sys.argv[2]
        batch_fetch(date_str)
    else:
        main(sys.argv[1])
