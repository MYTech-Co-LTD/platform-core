-- 015_client_store_override.sql — 批发客户→门店的**人工对照表**（#517 段②；spec §5）。
--
-- 唯一用途：WO 行的 client_fid→store_code 解析兜底——发布侧（publish-dims）**先查本表，
-- 未命中再走「客户档案名 ↔ dim_branch 名精确同名」**。它兜的是「改名漂移」（一端改名导致
-- 同名断链）：断链行不进取价面 + 大声红 → 人工在这里补一行，发布即恢复。
--
-- 分工铁律（spec §5）：dim_branch 是门店唯一事实源；本表只存「键→码」对照，
-- 行不进 dim_branch、不进任何门店列表；store_code 必须是 dim_branch.code 的既有值
-- （发布侧不校验外键是有意的——坏码会在下游 join 时暴露为空行，无人可盲写）。
--
-- 维护方式：SQL 手工维护（本期无管理 UI，YAGNI）；行极少（只有漂移过的客户才需要）。
-- 幂等：drop 重建（首建无消费方）。
drop table if exists data.client_store_override;

create table data.client_store_override (
  org        text not null,
  client_fid text not null,
  store_code text not null,
  primary key (org, client_fid)
);
