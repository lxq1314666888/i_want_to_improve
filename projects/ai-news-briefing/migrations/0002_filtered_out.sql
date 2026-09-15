-- 记录被关键词/标题长度规则过滤掉的条数。
-- 用于区分「源本身没有内容」与「内容被合规规则挡掉」，避免把过滤误读成采集失败。
ALTER TABLE collection_runs ADD COLUMN filtered_out INTEGER NOT NULL DEFAULT 0;
