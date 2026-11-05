# tags/zhcn.csv 数据来源与生成方式

## 是什么

`zhcn.csv` 是 Danbooru 标签的中文对照表（`tag,中文`，无表头，UTF-8，CSV 引号包裹）。
前端 `js/tag-index.js` 懒加载它，用于：

- 中文关键词联想（输入 `白发` → `white_hair`）
- 英文标签旁的中文注解

## 来源（均为 MIT 许可）

| 来源 | 用途 | 说明 |
| --- | --- | --- |
| [ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table](https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table) | 主来源 | Gemini 初译 + 人工校对，每日更新，覆盖 33 万+ tag；取 release 里的 `tags.csv` |
| [amenorira/danbooru-tags-data-zh](https://github.com/amenorira/danbooru-tags-data-zh) | 补漏来源 | 按 artist/character/copyright/general/meta 分文件，带注释与别名，缺少中文名时保留日文假名原名 |

两者都只取 `tags/danbooru.csv` 里存在的标签，覆盖率约 84%（95,043 / 112,476）。

## 为什么换掉旧数据

旧版 `zhcn.csv` 对画师名做了机械音译，产出大量不存在的名字（例如 `happoubi_jin` → 「八方笔进」，
正确为「八宝备仁」；`umakuchi_shouyu` → 「马口手游」）。现版本画师名以人工校对译名或日文/拉丁原名呈现，
宁可不出中文，也不给错误名字。

## 生成规则

`python tools/build_zh_tags.py`（可加 `--proxy http://127.0.0.1:10808`、`--cache-dir <目录>` 复用下载缓存）

1. ffdkj 优先；ffdkj 只是原样回填（未翻译）时，取 ameniorira 的真译名
2. 繁体统一转简体（依赖 `pip install opencc-python-reimplemented`，缺失时跳过转换）
3. 去掉「（画师）」这类无信息后缀
4. 译名与标签本身相同（未真正翻译）的条目丢弃，不给界面塞重复内容
5. 画师名若与某个普通标签的译名相同（如 `bow_(bhp)` → 「蝴蝶结」），判定为把名字当普通单词直译，丢弃
6. 人工校对覆盖表 `OVERRIDES` / 丢弃表 `DROP_TAGS` 写在脚本里，每条附原因

改完数据记得同步 `tags/manifest.json` 的 `zhVersion`，用于刷新浏览器缓存。
