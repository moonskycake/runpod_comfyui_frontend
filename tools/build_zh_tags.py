"""Rebuild tags/zhcn.csv (Danbooru 标签中文对照表) from curated community datasets.

来源（均为 MIT 许可）：
  1. ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table  —— 主来源
     AI(Gemini) 初译 + 人工校对，每日更新，覆盖 33 万+ tag（tags.csv 为 release 资产）
  2. amenorira/danbooru-tags-data-zh —— 补充来源
     按 artist/character/copyright/general/meta 分文件，带注释与别名，保留日文假名原名

处理规则（保持"宁缺勿错"）：
  - ffdkj 优先，缺失时用 amenorira 补
  - 繁体统一转简体
  - 去掉「（画师）」这类无信息后缀
  - 中文与标签本身相同（未翻译）的直接丢弃，不给界面塞重复内容
  - 少量人工校对覆盖（OVERRIDES）

用法：
  python tools/build_zh_tags.py                     # 联网下载（可加 --proxy http://127.0.0.1:10808）
  python tools/build_zh_tags.py --cache-dir <dir>   # 复用/缓存下载文件
"""

import argparse
import csv
import io
import json
import os
import sys
import urllib.request

category_of = {}

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAGS_DIR = os.path.join(REPO_ROOT, 'tags')

FFDKJ_RELEASE_API = (
    'https://api.github.com/repos/ffdkj/'
    'ffdkj-Danbooru_Tag-Chinese-English-Translation-Table/releases/latest'
)
AMEN_BASE = 'https://raw.githubusercontent.com/amenorira/danbooru-tags-data-zh/main/tags'
AMEN_CATEGORIES = ('artist', 'character', 'copyright', 'general', 'meta')

# 人工校对：确认为误译/漏译的条目（键为标签名，值为正确译文）
OVERRIDES = {
    # commentary_request = 作者希望观众留下评论，与"翻译"无关
    'commentary_request': '求评论',
    # fuzichoco 是「藤ちょこ」，不是姓氏「藤原」
    'fuzichoco': '藤ちょこ',
    # 两个数据源都缺这条（《路人女主的养成方法》插画师）
    'misaki_kurehito': '深崎暮人',
}

# 人工校对：确认为误译但无法确定正确读法的条目，直接不给中文标注
DROP_TAGS = {
    'omutatsu',    # おむたつ，并非「辰巳」(tatsumi)
    'fuzukikai',   # ふずきかい，被按字面拆成了「风俗改」
}

NO_INFO_SUFFIXES = ('（画师）', '(画师)')


def http_get(url, proxy=None):
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, headers={'User-Agent': 'build-zh-tags'})
    with opener.open(req, timeout=120) as res:
        return res.read()


def cached_get(url, cache_path, proxy=None):
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return io.open(cache_path, 'rb').read()
    data = http_get(url, proxy)
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with io.open(cache_path, 'wb') as fh:
        fh.write(data)
    return data


def load_ffdkj(cache_dir, proxy):
    cache = os.path.join(cache_dir, 'ffdkj_tags.csv')
    if not os.path.exists(cache):
        release = json.loads(http_get(FFDKJ_RELEASE_API, proxy).decode('utf-8'))
        asset = next((a for a in release.get('assets', []) if a['name'] == 'tags.csv'), None)
        if asset is None:
            raise SystemExit('ffdkj release 中找不到 tags.csv')
        return cached_get(asset['browser_download_url'], cache, proxy)

    return io.open(cache, 'rb').read()


def parse_ffdkj(raw):
    out = {}
    for row in csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))):
        name = (row.get('name') or '').strip().lower()
        zh = (row.get('cn_name') or '').strip()
        if name and zh:
            out[name] = zh
    return out


def parse_amenorira(cache_dir, proxy):
    out = {}
    for cat in AMEN_CATEGORIES:
        cache = os.path.join(cache_dir, f'amen_{cat}.csv')
        data = cached_get(f'{AMEN_BASE}/{cat}.csv', cache, proxy)
        for row in csv.DictReader(io.StringIO(data.decode('utf-8-sig'))):
            name = (row.get('tag') or '').strip().lower()
            zh = (row.get('zh') or '').strip()
            if name and zh:
                out.setdefault(name, zh)
    return out


def load_converter():
    try:
        from opencc import OpenCC  # pip install opencc-python-reimplemented
    except ImportError:
        print('警告：未安装 opencc，跳过繁→简转换（pip install opencc-python-reimplemented）')
        return None
    cc = OpenCC('t2s')
    return cc.convert


def clean_zh(zh, convert):
    text = zh.strip()
    for suffix in NO_INFO_SUFFIXES:
        if text.endswith(suffix):
            text = text[: -len(suffix)].strip()
    if convert:
        text = convert(text)
    return text.strip()


def is_echo(zh, tag):
    """中文与标签本身相同（未真正翻译）"""
    norm = zh.lower().replace(' ', '_').strip()
    return norm == tag or norm.replace('_', '') == tag.replace('_', '')


def strip_qualifier(zh):
    """去掉译名尾部的括号限定，如「蝴蝶结（BHP）」-> 「蝴蝶结」"""
    idx = zh.find('（')
    if idx == -1:
        idx = zh.find('(')
    return (zh[:idx] if idx > 0 else zh).strip()


def load_danbooru_tags(path):
    """按 danbooru.csv 顺序返回 (标签->分类, 标签列表)（保证输出稳定、便于 diff）"""
    categories = {}
    tags = []
    with io.open(path, encoding='utf-8', errors='replace', newline='') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            parts = line.split(',')
            tag = parts[0].strip().lower()
            if not tag:
                continue
            tags.append(tag)
            if len(parts) > 1:
                try:
                    categories[tag] = int(parts[1])
                except ValueError:
                    pass
    return categories, tags


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--proxy', default=os.environ.get('BUILD_ZH_PROXY', ''))
    parser.add_argument('--cache-dir', default=os.path.join(TAGS_DIR, '.zh-src-cache'))
    args = parser.parse_args()

    global category_of
    category_of, danbooru_tags = load_danbooru_tags(os.path.join(TAGS_DIR, 'danbooru.csv'))
    known = set(danbooru_tags)
    print(f'当前标签库：{len(known)} 个标签')

    primary = parse_ffdkj(load_ffdkj(args.cache_dir, args.proxy))
    fallback = parse_amenorira(args.cache_dir, args.proxy)
    print(f'ffdkj 词条：{len(primary)}；amenorira 词条：{len(fallback)}')

    convert = load_converter()

    # 普通标签的中文译名（用于识别「画师名被当成普通单词直译」：bow_(bhp) -> 蝴蝶结）
    common_zh = {}
    for tag in danbooru_tags:
        if tag in DROP_TAGS:
            continue
        zh = clean_zh(primary[tag], convert) if tag in primary else ''
        if zh and is_echo(zh, tag):
            zh = ''
        elif not zh and tag in fallback:
            zh = clean_zh(fallback[tag], convert)
        # 只拿 general(0)/meta(5) 的「无括号限定」标签译名做对照；
        # 角色/作品/服装类标签常与画师同名（如 shigure_ui_(vtuber)_(cosplay)），不能当证据
        if zh and category_of.get(tag) in (0, 5) and '(' not in tag:
            common_zh.setdefault(strip_qualifier(zh), tag)

    merged = {}
    from_primary = from_fallback = dropped_echo = dropped_artist_guard = 0
    for tag in danbooru_tags:
        if tag in DROP_TAGS:
            continue
        if tag in OVERRIDES:
            merged[tag] = OVERRIDES[tag]
            continue

        # 主来源优先；主来源只是原样回填（未翻译）时，取补充来源里真正的译名
        zh = clean_zh(primary[tag], convert) if tag in primary else ''
        if zh and is_echo(zh, tag):
            zh = ''
        if zh:
            from_primary += 1
        elif tag in fallback:
            alt = clean_zh(fallback[tag], convert)
            if alt and not is_echo(alt, tag):
                zh = alt
                from_fallback += 1

        if not zh:
            if tag in primary or tag in fallback:
                dropped_echo += 1
            continue

        # 画师名若与某个普通标签的译名相同，多半是把名字当成普通单词直译了
        if category_of.get(tag) == 1 and strip_qualifier(zh) in common_zh:
            dropped_artist_guard += 1
            continue

        merged[tag] = zh

    out_path = os.path.join(TAGS_DIR, 'zhcn.csv')
    with io.open(out_path, 'w', encoding='utf-8', newline='\n') as fh:
        writer = csv.writer(fh, quoting=csv.QUOTE_ALL, lineterminator='\n')
        for tag in danbooru_tags:
            if tag in merged:
                writer.writerow([tag, merged[tag]])

    total = len(merged)
    print(f'写入 {out_path}')
    print(f'  有效中文词条：{total}（占标签库 {total * 100 // max(1, len(known))}%）')
    print(f'  来自 ffdkj：{from_primary}；来自 amenorira 补漏：{from_fallback}；丢弃未翻译：{dropped_echo}')
    print(f'  体积：{os.path.getsize(out_path) / 1024 / 1024:.2f} MB')


if __name__ == '__main__':
    sys.exit(main())
