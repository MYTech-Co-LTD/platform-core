# 乐檬八类角色 65 项指标数据源与公式总册（客户原件附录）

> **来源**：客户提供的 Word 文档《乐檬八类角色65项指标数据源与公式总册.docx》（文内落款 2026-10-08，微信传送）。
> 本文件为 **textutil 纯文本提取**，仅作排版转换，内容逐字未改。客户原文声明「接口与字段依据本地保存的官方能力文档核对，
> 未在本轮重新验证线上可用性」——**线上可用性已由我方 2026-10-12 探针补验**，结论见同日设计 spec
> 《2026-10-12-lemeng-metrics-sources-semantics-design.md》§2（3 个接口不可用：D06/D08/D09）。
> 本附录是指标口径与源引用的**需求侧输入**；实现侧的唯一事实源仍是 `dbt/semantics/l1_metrics.yml` 与采集契约。

---

乐檬八类角色指标数据源与计算公式
接口采集 数据字段 关联关系 计算公式 2026年10月8日
范围　沿用原方案8个角色、65项角色指标。重复指标使用同一计算定义；本文件为采集与计算设计，不包含新取数实绩。接口与字段依据本地保存的官方能力文档核对，未在本轮重新验证线上可用性。
阅读方法　每项指标列D编号接口和X编号补充来源，全文末尾给出完整接口名、请求方法、参数和字段。X字段均为建议数据模型，不是虚构的乐檬接口字段。
条件标识　A表示既有字段可启动；B表示需要核定口径或关联；C表示仍需补充关键数据。频率与条件沿用原方案，最终以本项数据条件和接口字典为准。
统一控制　审核单据只取业务上已审核状态，但各接口状态编码不同。金额保留红字，null不当0；先按源粒度汇总再连接。零分母标不适用，缺关键数据不输出确定数值。

01 总经理
管理范围　总仓与门店零售分别展示；下钻到战区、门店或客户，不将内部配送与终端零售相加作为企业收入。
01 01 总仓出库净额
采集接口与来源　D01 配送出库；D02 批发销售；D03 批发退货；D12 门店档案；D13 客户档案；X01 组织与营业日历
使用字段　D01.total_money；D02.wholesale_order_total_money；D03.wholesale_return_total_money
计算公式　按定义R计算；日、月、战区均先分别汇总配送和批发后合并。
关联与粒度　配送branch_num、批发client_fid关联X01生效期映射；单号含业务类型去重。
数据条件　总仓按D01.out_branch_num、D02/D03.branch_num筛发货主体；不得混入店间调拨或零售收入。
频率与管理动作　日 周 月｜A；判断业务规模与结构变化。
01 02 总仓毛利与毛利率
采集接口与来源　D01 配送出库；D02 批发销售；D03 批发退货；D10 经营指标校验
使用字段　D01.total_money；D02.wholesale_order_total_money；D03.wholesale_return_total_money；D01.items.cost_subtotal；D02.wholesale_order_cost_money；D03.wholesale_return_cost_money
计算公式　G＝R－C；毛利率＝G/R×100%；系统差异＝ΣD10.actual_value(metric=transfer_profit)－配送单据毛利。
关联与粒度　同期间、同发货中心与收货范围；D01按order_no汇总明细成本，D02/D03按单头。
数据条件　成本缺失、税基或成本时点未统一时只能试算；系统指标差异不自动认定为损失。
频率与管理动作　周 月｜B；决定价格和成本核查重点。
01 03 费用后贡献与贡献率
采集接口与来源　D01 配送出库；D02 批发销售；D03 批发退货；D04 门店费用；D05 客户费用；D12 门店档案；D13 客户档案；X01 组织与营业日历
使用字段　D01.total_money；D02.wholesale_order_total_money；D03.wholesale_return_total_money；D01.items.cost_subtotal；D02.wholesale_order_cost_money；D03.wholesale_return_cost_money；D04.amount/direction/expense_type；D05.other_inout_money/other_inout_flag/other_inout_kind
计算公式　N＝R－C－E；贡献率＝N/R×100%。
关联与粒度　先按门店或客户分别聚合业务与费用，再按对象ID和期间连接。
数据条件　不按单据逐行连接全部费用，避免一对多放大；审核发生费用不自动等于该期会计费用。
频率与管理动作　月｜B；看规模是否转化为贡献；不当作净利润。
01 04 战区贡献与占比
采集接口与来源　D01 配送出库；D02 批发销售；D03 批发退货；D04 门店费用；D05 客户费用；D12 门店档案；D13 客户档案；X01 组织与营业日历
使用字段　D01.total_money；D02.wholesale_order_total_money；D03.wholesale_return_total_money；D01.items.cost_subtotal；D02.wholesale_order_cost_money；D03.wholesale_return_cost_money；D04.amount/direction/expense_type；D05.other_inout_money/other_inout_flag/other_inout_kind
计算公式　每战区Nw＝Rw－Cw－Ew；贡献占比＝Nw/Σ同完整范围Nw×100%。
关联与粒度　D01/D04.branch_num；D02/D03/D05.client_fid→X01战区；生效期覆盖业务日期。
数据条件　只计东、西、中、南；未映射单列，不分摊。分母非正时不作常规占比排名。
频率与管理动作　月｜B；比较战区贡献，安排经营支持。
01 05 可比门店增长率
采集接口与来源　D07 零售销售；D12 门店档案；X01 组织与营业日历；X09 采集与勾稽日志
使用字段　D07.branch_num/bizday/sale_money/return_money；X01营业日、开闭店日期
计算公式　取两期均可比门店集合B；增长率＝ΣB本期L/ΣB上期L－1。营业天数不等时，另报(本期L/本期营业店日)/(上期L/上期营业店日)－1。
关联与粒度　branch_num＋bizday补齐营业日历；每个日期核对X09取数完整。
数据条件　缺行不能直接作零；闭店日和新开店须按规则排除。
频率与管理动作　月｜B；区分存量增长与门店增减影响。
01 06 规则闭店及清理暴露
采集接口与来源　D07 零售销售；D12 门店档案；D01 配送出库；D04 门店费用；X01 组织与营业日历；X09 采集与勾稽日志
使用字段　D07.sale_money/bizday；D01.audit_time/total_money；D04.audit_time/amount/direction
计算公式　当日正向销售＝max(Σsale_money,0)；连续15个完整自然日均无正向销售→规则闭店候选。判定后分别Σ出库额、费用应付和应收。
关联与粒度　branch_num＋日历；取数完整后补零，并与门店确认记录核对。
数据条件　使用用户半月规则的可执行口径；无数据与无业绩区分。月报可另用9月16—30日固定窗口。
频率与管理动作　周｜A/B；发起闭店复核、停止误补货与清理。
01 07 供应商集中度
采集接口与来源　D11 采购分析；D14 商品档案
使用字段　D11.supplier_num/item_num/money_total；D14.item_department
计算公式　先按供应商ΣP降序；CR5＝前5净采购额/全部净采购额，CR10同理。水果或标品先筛部门。
关联与粒度　item_num关联D14，供应商以supplier_num分组。
数据条件　净采购为负的供应商及非正总额单列；同一供应商跨部门不能重复计总体家数。
频率与管理动作　月｜A；检查依赖程度与备选供应能力。
01 08 关键数据未核金额
采集接口与来源　D01 配送出库；D02 批发销售；D03 批发退货；D04 门店费用；D05 客户费用；D10 经营指标校验；D12 门店档案；D13 客户档案；X01 组织与营业日历；X09 采集与勾稽日志
使用字段　D01.items.cost_subtotal；D02.wholesale_order_cost_money；D03.wholesale_return_cost_money；D01.items.out_money；客户区域映射、采集日志
计算公式　缺成本金额＝Σ对应成本为null的业务金额；零成本金额另算。未归属金额＝Σ映射为空出库净额。口径差额按gross定义，失败率＝失败请求数/总请求数。
关联与粒度　单号＋业务类型；客户或门店ID；按采集批次保存覆盖期。
数据条件　各类暴露可能重叠，不相加为总损失；本指标不衡量员工违规。
频率与管理动作　日 周｜A；判断哪些经营结论暂不能用于考核。

02 战区总
管理范围　东部、西部、中部、南部独立归属；按要求排除其他门店、贵州宣威大区和广西大区。
02 01 战区出库净额
采集接口与来源　D01 配送出库；D02 批发销售；D03 批发退货；D12 门店档案；D13 客户档案；X01 组织与营业日历
使用字段　D01.total_money；D02.wholesale_order_total_money；D03.wholesale_return_total_money
计算公式　按定义R计算；日、月、战区均先分别汇总配送和批发后合并。
关联与粒度　配送branch_num、批发client_fid关联X01生效期映射；单号含业务类型去重。
数据条件　总仓按D01.out_branch_num、D02/D03.branch_num筛发货主体；不得混入店间调拨或零售收入。
频率与管理动作　日 周 月｜B；检查区域规模及业务归属。
02 02 战区毛利率
采集接口与来源　D01 配送出库；D02 批发销售；D03 批发退货；D10 经营指标校验
使用字段　D01.total_money；D02.wholesale_order_total_money；D03.wholesale_return_total_money；D01.items.cost_subtotal；D02.wholesale_order_cost_money；D03.wholesale_return_cost_money
计算公式　G＝R－C；毛利率＝G/R×100%；系统差异＝ΣD10.actual_value(metric=transfer_profit)－配送单据毛利。
关联与粒度　同期间、同发货中心与收货范围；D01按order_no汇总明细成本，D02/D03按单头。
数据条件　成本缺失、税基或成本时点未统一时只能试算；系统指标差异不自动认定为损失。
频率与管理动作　周 月｜B；定位低毛利区域和商品。
02 03 战区净费用与费用率
采集接口与来源　D04 门店费用；D05 客户费用；D01 配送出库；D02 批发销售；D03 批发退货；X01 组织与营业日历
使用字段　D04.amount/direction/expense_type；D05.other_inout_money/other_inout_flag/other_inout_kind
计算公式　分别列EPb、ERb、EPc、ERc；E＝应付合计－应收合计。战区费用率＝Ew/Rw×100%。
关联与粒度　D04.branch_num归门店；D05.client_fid归客户；费用率使用本角色out口径R。
数据条件　战区费用率还需本角色R的数据源D01—D03及X01；费用本身不等于余额。
频率与管理动作　周 月｜B；核查补贴与补损，同时保留收支两方向。
02 04 战区费用后贡献
采集接口与来源　D01 配送出库；D02 批发销售；D03 批发退货；D04 门店费用；D05 客户费用；D12 门店档案；D13 客户档案；X01 组织与营业日历
使用字段　D01.total_money；D02.wholesale_order_total_money；D03.wholesale_return_total_money；D01.items.cost_subtotal；D02.wholesale_order_cost_money；D03.wholesale_return_cost_money；D04.amount/direction/expense_type；D05.other_inout_money/other_inout_flag/other_inout_kind
计算公式　N＝R－C－E；贡献率＝N/R×100%。
关联与粒度　先按门店或客户分别聚合业务与费用，再按对象ID和期间连接。
数据条件　不按单据逐行连接全部费用，避免一对多放大；审核发生费用不自动等于该期会计费用。
频率与管理动作　月｜B；评价费用抵减后的经营贡献。
02 05 毛利变化原因
采集接口与来源　D01 配送出库；D02 批发销售；D03 批发退货；D04 门店费用；D05 客户费用；D14 商品档案
使用字段　D01.total_money；D02.wholesale_order_total_money；D03.wholesale_return_total_money；D01.items.cost_subtotal；D02.wholesale_order_cost_money；D03.wholesale_return_cost_money；商品明细金额数量及费用
计算公式　两期R、商品收入占比wi、商品毛利率mi：规模效应=(R1−R0)Σw0m0；结构效应=R1Σ(w1−w0)m0；毛利率效应=R1Σw1(m1−m0)；净费用效应=−(E1−E0)。相加得到贡献变化，新增退出及未匹配差额单列。
关联与粒度　同商品同单位比较；商品毛利需明细成本分配与单头勾稽；跨期商品ID稳定。
数据条件　仅可比商品可进一步用单位售价p和成本c拆率：价格项=c0(1/p0−1/p1)，成本项=−(c1−c0)/p1；p=0或新旧缺失时不强算。
频率与管理动作　月｜B；区分价格、采购成本和运营原因。
02 06 低贡献门店占比
采集接口与来源　D01 配送出库；D02 批发销售；D03 批发退货；D04 门店费用；D05 客户费用；X01 组织与营业日历；X08 口径阈值与商品范围
使用字段　D01.total_money；D02.wholesale_order_total_money；D03.wholesale_return_total_money；D01.items.cost_subtotal；D02.wholesale_order_cost_money；D03.wholesale_return_cost_money；D04.amount/direction/expense_type；D05.other_inout_money/other_inout_flag/other_inout_kind；目标值
计算公式　逐店N＝R−C−E；低贡献占比＝COUNT(N低于批准目标且数据完整门店)/COUNT(可评价门店)×100%。无目标仅列N<0。
关联与粒度　按branch_num，客户映射需先确认，目标按对象及生效期关联。
数据条件　没有目标不自设门槛；不把缺数据门店记为零贡献。
频率与管理动作　周 月｜B；安排区域经理专项改善。
02 07 门店补损率
采集接口与来源　D04 门店费用；D05 客户费用；D01 配送出库；D02 批发销售；D03 批发退货；D14 商品档案
使用字段　D04.amount/direction/expense_type；D05.other_inout_money/other_inout_flag/other_inout_kind；D01.total_money；D02.wholesale_order_total_money；D03.wholesale_return_total_money
计算公式　补损率＝Q/同对象同期间R；补损侵蚀率＝Q/G（仅G>0）；Q和R分别展示。
关联与粒度　门店用branch_num；客户用client_fid；项目按批准映射；毛利分母另用对应gross成本源。
数据条件　审核发生口径与原销售归属期口径分开；不把所有应付项目都视为补损。
频率与管理动作　周 月｜A；找出持续补损的区域。
02 08 问题按期处理率
采集接口与来源　X03 整改与复核台账
使用字段　issue_id/due_at/verified_at/verify_status
计算公式　按期完成率＝COUNT(本期到期且verified_at≤due_at且复核通过事项)/COUNT(本期到期事项)×100%。
关联与粒度　issue_id去重，按owner_id和角色管理范围分组。
数据条件　未复核关闭不能计完成；取消、延期按批准后的口径保留历史版本。
频率与管理动作　周｜C；检查跨部门问题是否得到处理。

03 区域经理
管理范围　仅负责辖区门店；终端零售表现与总部对门店供货表现分栏展示。
03 01 门店零售净额及变化
采集接口与来源　D07 零售销售；X01 组织与营业日历；X09 采集与勾稽日志
使用字段　branch_num/bizday/sale_money/return_money
计算公式　L＝Σsale_money−Σreturn_money；变化额=L1−L0；变化率=L1/L0−1；可比增长按same定义。
关联与粒度　按branch_num/bizday聚合，与营业日历核对。
数据条件　sale_count不作订单数；同营业日和券口径再比较。
频率与管理动作　日 周｜A/B；发现持续下滑门店并安排巡店。
03 02 零售毛利率
采集接口与来源　D08 零售毛利
使用字段　sale_money_no_coupon/profit_money_no_coupon；或sale_money/profit_money
计算公式　不含券毛利率＝Σprofit_money_no_coupon/Σsale_money_no_coupon；含券口径＝Σprofit_money/Σsale_money。
关联与粒度　同查询参数、同部门和门店范围聚合，所选口径成对使用。
数据条件　sale_cost用于勾稽，不再从profit_money扣一遍；成本权限缺失则不计算。
频率与管理动作　日 周｜B；检查商品结构、价格与损耗影响。
03 03 客单价
采集接口与来源　D09 客单分析
使用字段　receive_money/customer_nums；备查customer_ave_price_no_coupon
计算公式　不含券客单价＝Σreceive_money/Σcustomer_nums。用门店或门店日维度，避免重复客单。
关联与粒度　branch_num＋bizday；同查询条件，查询结果可能返回已聚合客单数。
数据条件　不累加商品/品类切片客单数；不能用D07.sale_count替代。系统退款处理规则上线前核对。
频率与管理动作　日 周｜B；区分客流问题与购买金额问题。
03 04 门店补损与补贴率
采集接口与来源　D04 门店费用；D01 配送出库
使用字段　D04.amount/direction/expense_type；D01.total_money
计算公式　分别筛补损、直播补贴、小程序或线下补贴项目；各项净发生额/同门店配送出库净额×100%。
关联与粒度　branch_num＋期间；按费用项目字典归类。
数据条件　结果是供货费用强度，不是门店零售费用率；客户费用需另外可靠映射后再计。
频率与管理动作　周｜A；检查费用原因并补充原单证据。
03 05 连续无业绩天数
采集接口与来源　D07 零售销售；D12 门店档案；X01 组织与营业日历；X09 采集与勾稽日志
使用字段　sale_money/bizday/branch_num；完整日历标记
计算公式　从报告日向前逐日累计连续无正向销售天数；满足15日规则列复核候选。
关联与粒度　与完整日历做左关联，先检查采集完整再补0。
数据条件　休业、断数、新开店需人工核对，不能仅凭缺记录判闭店。
频率与管理动作　日｜A/B；排查闭店、系统断数或经营异常。
03 06 要货满足率
采集接口与来源　D15 要货单；D01 配送出库；D16 配送调入单；X06 WMS或TMS批次与事件
使用字段　D15.order_no/items.quantity；D01.related_order_no/items.out_quantity；D16.related_order_no/items.in_quantity
计算公式　有效要货行中，截止承诺时点累计有效发出数量≥批准要货数量的行数/有效要货行数。若考核收货满足率，则改用累计签收数量。
关联与粒度　原要货行→出库关联单→调入单；同item_num、单位及批次，分次履约先累计；需稳定原行号。
数据条件　D15明细到200行需核对截断；related_order_no含义须抽单验证。无承诺时间只能算截止日满足率，不能标按期。
频率与管理动作　日 周｜C；区分订货、缺配与出库问题。
03 07 库存覆盖天数
采集接口与来源　D17 库存快照；D07 零售销售；X01 组织与营业日历；X08 口径阈值与商品范围
使用字段　inventory_quantity；sale_num/return_num；批准窗口N
计算公式　日均净销量＝ΣN日(sale_num−return_num)/可比营业日数；覆盖天数＝报告日可售库存数量/日均净销量。
关联与粒度　branch_num＋item_num＋单位；仓库汇总范围固定。
数据条件　inventory_quantity未区分冻结/残次库存，需补可售标记；净销量≤0单列，不强算天数。
频率与管理动作　日｜C；安排调拨与补货，避免积压。
03 08 门店改善完成率
采集接口与来源　X03 整改与复核台账
使用字段　issue_id/due_at/verified_at/verify_status
计算公式　按期完成率＝COUNT(本期到期且verified_at≤due_at且复核通过事项)/COUNT(本期到期事项)×100%。
关联与粒度　issue_id去重，按owner_id和角色管理范围分组。
数据条件　未复核关闭不能计完成；取消、延期按批准后的口径保留历史版本。
频率与管理动作　周｜C；防止问题反复出现。

04 仓储负责人
管理范围　按总仓、仓库、配送或批发业务、日期区分；店间调拨单列。
04 01 每日出库单数与行数
采集接口与来源　D01 配送出库；D02 批发销售
使用字段　D01.order_no/items；D02.wholesale_order_fid/wholesale_order_details；审核时间
计算公式　日单数＝COUNT DISTINCT(业务类型,单号)；日明细行数＝SUM各单完整明细长度；配送批发分别列。
关联与粒度　按audit_time/wholesale_order_audit_time截日；批发行以单号＋order_detail_num去重。
数据条件　审核日工作量是代理指标，不代表实际拣货日；退货作业如计入须D03另列。
频率与管理动作　日｜A；安排拣货、复核班次。
04 02 峰值负荷倍数
采集接口与来源　D01 配送出库；D02 批发销售；X01 组织与营业日历
使用字段　同workload日单数、日明细行数；完整日期序列
计算公式　峰值倍数＝MAX(日单数)/AVG(日单数)；明细行数单独计算。自然日口径需补齐真零天。
关联与粒度　固定期间和工作日/自然日规则，与取数覆盖日历对齐。
数据条件　不能只对有单日求日均后称自然日日均。
频率与管理动作　周 月｜A；提前应对高负荷日期。
04 03 出库至收货周期
采集接口与来源　D01 配送出库；D16 配送调入单；X06 WMS或TMS批次与事件
使用字段　出库与调入单号；X06.dispatch_at/received_at
计算公式　单据或批次周期＝最后有效签收时间−实际发出时间；输出中位数、P90和未签收数量。
关联与粒度　X06原出库单及行→D01.order_no→D16.related_order_no，分批按约定粒度计算。
数据条件　无实际事件时间时只能报审核间隔，不可冒充交付时长；未完成单不按0时长计。
频率与管理动作　日 周｜C；定位待收货和运输时效问题。
04 04 出入库数量差异率
采集接口与来源　D01 配送出库；D16 配送调入单
使用字段　D01.items.out_quantity；D16.items.in_quantity；related_order_no/item_num/lot_number
计算公式　已到截止点的出库行：差异率＝Σ|累计入库数量−发出数量|/Σ正向发出数量。同商品或统一基本单位分别算。
关联与粒度　出库单＋稳定原行号，辅以item_num、批次；多个入库行先汇总后连接。
数据条件　在途与已完成差异分开；不能把未到货直接视为丢失；不同单位不混加。
频率与管理动作　日｜C；追查漏配、错配和收货差异。
04 05 批号字段填写率
采集接口与来源　D01 配送出库；D02 批发销售；D14 商品档案；X08 口径阈值与商品范围
使用字段　D01.items.lot_number；D02.wholesale_order_details.order_detail_lot_number；item_num
计算公式　填写率＝需批号管理且批号有效的出库明细行数/需批号管理出库明细行数。全量行填写率可作补充。
关联与粒度　item_num关联X08需批号清单；行去重，空白和占位字符视为无效。
数据条件　字段完整率不证明实物批次正确，也不证明缺字段就不可追溯。
频率与管理动作　日 周｜B；补齐追溯字段；全量填写率另列。
04 06 零成本出库暴露
采集接口与来源　D01 配送出库；D02 批发销售
使用字段　D01.items.out_money/cost_subtotal；D02明细金额、成本单价、数量及赠品数量
计算公式　零成本暴露＝COUNT(金额≠0且已知成本=0)及Σ该条件金额；成本null另列缺失金额。
关联与粒度　配送直接用cost_subtotal；批发明细成本=单价×经核定的含赠品数量，与单头核对。
数据条件　免费商品与暂估问题需业务确认；零成本不等于全部利润可实现。
频率与管理动作　日｜A；与采购、财务核对成本原因。
04 07 负金额调整发生
采集接口与来源　D01 配送出库；D02 批发销售
使用字段　单号、total_money或wholesale_order_total_money、关联单号及备注
计算公式　负金额单数＝COUNT(单头金额<0)；负金额合计＝Σ负金额；有有效原单关联数/负金额单数。
关联与粒度　按业务类型＋单号去重；原单关联须核对，配送items不重复计单。
数据条件　负数可能是退补、冲红或调整，不按绝对值变正收入，也不一律称退货。
频率与管理动作　日 周｜A/B；复核退补和调整原因。
04 08 库存周转与临期金额
采集接口与来源　D17 库存快照；D01 配送出库；D02 批发销售；D03 批发退货；D14 商品档案；X06 WMS或TMS批次与事件；X08 口径阈值与商品范围
使用字段　inventory_money；出库成本C；X06批次库存成本/expiration_date
计算公式　库存周转天数＝日均库存成本/(期间出库成本/期间天数)；临期金额＝Σ(0≤到期日−报告日≤批准临期天数的在库批次成本)。
关联与粒度　库存与出库按同主体和仓库；按日快照算平均，或明确期初期末均值估算；批次需item_num＋lot_number。
数据条件　总仓库存不全时不算；D17无批号/到期日；D01到期信息不能代表仍在库批次。
频率与管理动作　周 月｜C；支持清库存、调拨和采购调整。

05 水果采购负责人
管理范围　按商品部门识别水果，保留品种、产地、等级、规格和单位用于价格比较。
05 01 水果采购净额与结构
采集接口与来源　D11 采购分析；D14 商品档案
使用字段　money_total/purchase_item_money/purchase_item_return_money；supplier_num/item_num；item_department
计算公式　采购净额P＝Σmoney_total；分部门、品类、供应商占比＝组内P/同范围P。购入与退货分量另列。
关联与粒度　item_num关联D14；查询supplier+item可做供应商与部门分组。
数据条件　耗材不按供应商名字分类。赠品金额是否纳入net按系统定义勾稽，不重复加。
频率与管理动作　日 周 月｜A；查看采购结构与主要资金投入。
05 02 同品加权采购价
采集接口与来源　D11 采购分析；D14 商品档案；X04 合同与商业条件
使用字段　purchase_item_money/purchase_item_amount/base_unit；商品规格、产地和合同条件
计算公式　同品加权价A＝Σ购入金额/Σ购入基本数量；同期供应商价差＝Asupplier−Abenchmark。
关联与粒度　按item_num＋等级规格＋基本单位＋税运费账期条件建立可比组，前后期分别查询。
数据条件　汇总接口仅支持2个维度；不包含的日期/门店粒度要通过分段参数保存，不能猜归属。
频率与管理动作　日 周｜B；识别涨价与议价机会。
05 03 可比供应商价差
采集接口与来源　D11 采购分析；D14 商品档案；X04 合同与商业条件
使用字段　同price；合同可比条件
计算公式　价差＝A供应商−A基准；价差率＝价差/A基准；机会金额＝价差×可替代且条件一致的计划数量。
关联与粒度　供应商×商品可比组；基准价和可替代量需采购确认。
数据条件　最低价不等于可获得价，未成交机会金额不计已实现节约。
频率与管理动作　周｜B；确定谈判对象，不直接认定节约收益。
05 04 关联品质补损率
采集接口与来源　D04 门店费用；D05 客户费用；D01 配送出库；D02 批发销售；D11 采购分析；X07 品质补损归因
使用字段　D04.amount/direction/expense_type；D05.other_inout_money/other_inout_flag/other_inout_kind；X07供应商/批次/品质标记/分配金额；对应供货金额
计算公式　品质补损率＝Σ明确关联本供应商批次的品质补损净额/该批次对应供货金额。
关联与粒度　费用单号→X07原单行/批次→供应商；分配金额合计必须等于原单。
数据条件　不能仅按D11采购占比摊补损；跨期品质问题按批次队列或发生期分别报告。
频率与管理动作　周 月｜C；判断品质改善与换商需求。
05 05 水果采购退货率
采集接口与来源　D11 采购分析；D14 商品档案
使用字段　purchase_item_return_money/purchase_item_money；purchase_item_return_amount/purchase_item_amount
计算公式　金额退货率＝Σ采购退货金额/Σ采购收货金额；数量率只在同商品同单位内计算。
关联与粒度　按supplier_num、item_num和部门；退货原因需采购原始退货单补充。
数据条件　同月退货可能对应前期采购，发生期率不等于该月进货质量不良率。
频率与管理动作　周 月｜A/B；区分质量退货、调整与跨期影响。
05 06 水果供应商集中度
采集接口与来源　D11 采购分析；D14 商品档案
使用字段　D11.supplier_num/item_num/money_total；D14.item_department
计算公式　先按供应商ΣP降序；CR5＝前5净采购额/全部净采购额，CR10同理。水果或标品先筛部门。
关联与粒度　item_num关联D14，供应商以supplier_num分组。
数据条件　净采购为负的供应商及非正总额单列；同一供应商跨部门不能重复计总体家数。
频率与管理动作　月｜A；准备关键品种备选供应商。
05 07 临期与库存覆盖
采集接口与来源　D17 库存快照；D07 零售销售；D14 商品档案；X06 WMS或TMS批次与事件；X08 口径阈值与商品范围
使用字段　库存数量、销售数量、批次库存与expiration_date
计算公式　覆盖天数按cover定义；临期金额按inventory定义；水果单独筛部门。
关联与粒度　item_num＋仓库＋批次；D14保质期只辅助校验，不代替批次到期日。
数据条件　批次库存/可售状态缺失时标未取得。
频率与管理动作　日｜C；调整频次、批量及调拨方案。
05 08 零金额采购行
采集接口与来源　D11 采购分析；D14 商品档案
使用字段　purchase_item_amount/purchase_item_money/purchase_present_amount
计算公式　按已选汇总粒度COUNT(购入数量>0且购入金额=0)；赠品数量单列。
关联与粒度　supplier_num＋item_num＋请求期间。
数据条件　这只是供应商商品汇总异常，不能称单据行数；需采购单据明细或系统导出才能定位原单。
频率与管理动作　日｜A/B；补齐成本后再评价毛利。

06 标品采购负责人
管理范围　优先按商品部门划分零食等标品；耗材独立列示，责任归属由企业确认，不按供应商名称推断品类。
06 01 标品采购净额与结构
采集接口与来源　D11 采购分析；D14 商品档案
使用字段　money_total/purchase_item_money/purchase_item_return_money；supplier_num/item_num；item_department
计算公式　采购净额P＝Σmoney_total；分部门、品类、供应商占比＝组内P/同范围P。购入与退货分量另列。
关联与粒度　item_num关联D14；查询supplier+item可做供应商与部门分组。
数据条件　耗材不按供应商名字分类。赠品金额是否纳入net按系统定义勾稽，不重复加。
频率与管理动作　周 月｜A；检查采购结构和高投入品类。
06 02 同规格采购价变化
采集接口与来源　D11 采购分析；D14 商品档案；X04 合同与商业条件
使用字段　购入金额、购入数量、规格与可比条件
计算公式　变化率＝本期A/基期A−1；影响额可估为(A1−A0)×本期可比购入数量。
关联与粒度　固定item_num/规格/单位/税运费和合同条件；不混入新规格。
数据条件　结果为同条件价差测算，不排除数量折扣、账期或品质变化影响。
频率与管理动作　周 月｜B；查进价上涨与合同执行差异。
06 03 商品出库毛利率
采集接口与来源　D01 配送出库；D02 批发销售；D03 批发退货；D14 商品档案
使用字段　D01.items.out_money/cost_subtotal；D02明细金额/成本/数量；D03退货明细金额/成本
计算公式　商品Ri＝配送明细金额＋批发明细金额−退货明细金额；Gi＝Ri−对应商品成本；率＝Gi/Ri。
关联与粒度　item_num＋单位；批发明细先与单头成本勾稽，差额单列或经批准分配。
数据条件　不能将整张单头成本分配给每个商品；赠品成本要包含且不重复计。
频率与管理动作　周 月｜B；结合售价与进价调整低毛利商品。
06 04 供应商集中度
采集接口与来源　D11 采购分析；D14 商品档案
使用字段　D11.supplier_num/item_num/money_total；D14.item_department
计算公式　先按供应商ΣP降序；CR5＝前5净采购额/全部净采购额，CR10同理。水果或标品先筛部门。
关联与粒度　item_num关联D14，供应商以supplier_num分组。
数据条件　净采购为负的供应商及非正总额单列；同一供应商跨部门不能重复计总体家数。
频率与管理动作　月｜A；平衡集中议价与供应依赖。
06 05 低动销库存金额
采集接口与来源　D17 库存快照；D07 零售销售；D14 商品档案；X08 口径阈值与商品范围
使用字段　inventory_money/inventory_quantity；sale_num/return_num；低动销阈值
计算公式　低动销库存额＝Σ(净销量≤批准阈值且有正库存商品的inventory_money)；零销量独立列。
关联与粒度　branch_num＋item_num＋同一窗口；完整商品库存集合左联销售。
数据条件　缺销售记录只有确认采集完整后才能视为零；缺库存不能用采购减出库代替。
频率与管理动作　周 月｜C；调整采购、退换货和促销。
06 06 采购退货率
采集接口与来源　D11 采购分析；D14 商品档案
使用字段　purchase_item_return_money/purchase_item_money；purchase_item_return_amount/purchase_item_amount
计算公式　金额退货率＝Σ采购退货金额/Σ采购收货金额；数量率只在同商品同单位内计算。
关联与粒度　按supplier_num、item_num和部门；退货原因需采购原始退货单补充。
数据条件　同月退货可能对应前期采购，发生期率不等于该月进货质量不良率。
频率与管理动作　月｜A/B；核查品质、临期与采购结构问题。
06 07 合同返利兑现率
采集接口与来源　D06 供应商费用；X04 合同与商业条件；X05 财务期初资金与核销
使用字段　D06费用项目/amount/direction/reference_bill；合同返利基数/比例/阶梯；到账核销
计算公式　应得返利＝按合同阶梯函数(有效采购或销售基数)计算；兑现率＝已核实实现返利/合同应得返利。
关联与粒度　supplier_num＋合同号＋有效期；费用单→核销→到账证据。
数据条件　开单、应计、抵货款和现金兑现分开；D06不可用且合同不全时不计算。
频率与管理动作　月 季｜C；跟进供应商返利和商务条件。
06 08 缺货与库存覆盖
采集接口与来源　D17 库存快照；D07 零售销售；D14 商品档案；X01 组织与营业日历；X08 口径阈值与商品范围
使用字段　每日inventory_quantity；有效在售商品、营业日、补货阈值
计算公式　缺货商品数＝COUNT(应售且可售库存≤0的商品)；持续缺货天数＝连续满足该条件营业日数；覆盖按cover。
关联与粒度　门店×商品×日期补齐完整应售清单，库存须区分可售状态。
数据条件　日末零库存只证明日末缺货，不能推算全天缺货时长或损失销售额。
频率与管理动作　日 周｜C；调整安全库存与补货频率。

07 运营负责人
管理范围　按门店、战区、活动和商品区分；费用按审核发生与业务归属期分别说明。
07 01 门店及客户费用结构
采集接口与来源　D04 门店费用；D05 客户费用；D01 配送出库；D02 批发销售；D03 批发退货；X01 组织与营业日历
使用字段　D04.amount/direction/expense_type；D05.other_inout_money/other_inout_flag/other_inout_kind
计算公式　分别列EPb、ERb、EPc、ERc；E＝应付合计－应收合计。战区费用率＝Ew/Rw×100%。
关联与粒度　D04.branch_num归门店；D05.client_fid归客户；费用率使用本角色out口径R。
数据条件　战区费用率还需本角色R的数据源D01—D03及X01；费用本身不等于余额。
频率与管理动作　周 月｜A；确认费用主要流向。
07 02 补贴强度
采集接口与来源　D04 门店费用；D05 客户费用；D07 零售销售；D01 配送出库；D02 批发销售；D03 批发退货；X02 活动与对照台账
使用字段　D04.amount/direction/expense_type；D05.other_inout_money/other_inout_flag/other_inout_kind；活动对象映射；零售L或出库R
计算公式　补贴强度＝活动补贴应付减应收/同范围L或R。必须固定采用零售还是供货分母。
关联与粒度　费用单号→campaign_id→门店/客户/商品/日期；先按相同活动范围汇总。
数据条件　无活动映射时仅可报审核期补贴强度，不报告活动ROI。
频率与管理动作　周 月｜A/B；发现高投入低产出的门店。
07 03 活动增量贡献
采集接口与来源　D08 零售毛利；D04 门店费用；D05 客户费用；X02 活动与对照台账
使用字段　profit_money_no_coupon或profit_money；活动基准毛利；增量净费用
计算公式　增量贡献＝活动实际毛利−可比基准毛利−增量活动净费用。基准可取批准的对照门店前后变化模型。
关联与粒度　campaign_id限定门店/商品/时间；同一券口径；费用分摊需守恒。
数据条件　并行活动重叠不能重复计收益；无对照及业务控制时只能称估算。
频率与管理动作　活动后｜C；判断活动是否继续及如何调整。
07 04 活动投入回报
采集接口与来源　D08 零售毛利；D04 门店费用；D05 客户费用；X02 活动与对照台账
使用字段　同increment；X02增量活动投入
计算公式　活动ROI＝增量贡献/增量活动投入×100%；分子已扣活动费用，不再次扣减。
关联与粒度　活动ID及唯一投入台账；投入与净费用口径分别定义。
数据条件　投入≤0不计算；不可拿总销售额/补贴额冒充利润ROI。
频率与管理动作　活动后｜C；比较可比活动的效率。
07 05 售后补损率
采集接口与来源　D04 门店费用；D05 客户费用；D01 配送出库；D02 批发销售；D03 批发退货；D14 商品档案
使用字段　D04.amount/direction/expense_type；D05.other_inout_money/other_inout_flag/other_inout_kind；D01.total_money；D02.wholesale_order_total_money；D03.wholesale_return_total_money
计算公式　补损率＝Q/同对象同期间R；补损侵蚀率＝Q/G（仅G>0）；Q和R分别展示。
关联与粒度　门店用branch_num；客户用client_fid；项目按批准映射；毛利分母另用对应gross成本源。
数据条件　审核发生口径与原销售归属期口径分开；不把所有应付项目都视为补损。
频率与管理动作　周 月｜A/B；推动品质与门店操作改善。
07 06 可比门店零售增长
采集接口与来源　D07 零售销售；D12 门店档案；X01 组织与营业日历；X09 采集与勾稽日志
使用字段　D07.branch_num/bizday/sale_money/return_money；X01营业日、开闭店日期
计算公式　取两期均可比门店集合B；增长率＝ΣB本期L/ΣB上期L－1。营业天数不等时，另报(本期L/本期营业店日)/(上期L/上期营业店日)－1。
关联与粒度　branch_num＋bizday补齐营业日历；每个日期核对X09取数完整。
数据条件　缺行不能直接作零；闭店日和新开店须按规则排除。
频率与管理动作　周 月｜B；识别可复制的运营做法。
07 07 费用异常命中与确认
采集接口与来源　D04 门店费用；D05 客户费用；D06 供应商费用；X08 口径阈值与商品范围；X03 整改与复核台账
使用字段　费用域、单号、对象ID、项目、方向、金额、审核日期、原单号、备注
计算公式　候选规则＝同对象/项目/方向/金额且日期差≤批准窗口，或同有效原单号重复；金额按候选涉及的唯一费用单汇总；确认率＝人工确认问题数/已复核候选数。
关联与粒度　单据主键使用费用域＋单号；比对关联原单、负数冲回及结算情况；X03记确认。
数据条件　候选配对不能重复加总同一单金额；候选不是违规。无D06时明确供应商费用未覆盖。
频率与管理动作　日 周｜A/B；推动重复补贴和退款复核。
07 08 运营整改按期完成率
采集接口与来源　X03 整改与复核台账
使用字段　issue_id/due_at/verified_at/verify_status
计算公式　按期完成率＝COUNT(本期到期且verified_at≤due_at且复核通过事项)/COUNT(本期到期事项)×100%。
关联与粒度　issue_id去重，按owner_id和角色管理范围分组。
数据条件　未复核关闭不能计完成；取消、延期按批准后的口径保留历史版本。
频率与管理动作　周｜C；跟踪措施是否真正落地。

08 财务负责人
管理范围　总部视角列应收应付方向；业务发生、结算、核销与现金收付分开。管理贡献不能直接替代会计利润。
08 01 总仓成本与毛利勾稽
采集接口与来源　D01 配送出库；D02 批发销售；D03 批发退货；D10 经营指标校验
使用字段　D01.total_money；D02.wholesale_order_total_money；D03.wholesale_return_total_money；D01.items.cost_subtotal；D02.wholesale_order_cost_money；D03.wholesale_return_cost_money
计算公式　G＝R－C；毛利率＝G/R×100%；系统差异＝ΣD10.actual_value(metric=transfer_profit)－配送单据毛利。
关联与粒度　同期间、同发货中心与收货范围；D01按order_no汇总明细成本，D02/D03按单头。
数据条件　成本缺失、税基或成本时点未统一时只能试算；系统指标差异不自动认定为损失。
频率与管理动作　日 月｜B；先核清成本和金额差异。
08 02 门店费用收支
采集接口与来源　D04 门店费用
使用字段　branch_num/expense_type/direction/amount/audit_time
计算公式　应收＝Σamount(direction=应收)；应付＝Σamount(direction=应付)；净费用＝应付−应收。
关联与粒度　门店＋项目＋审核期间；bill_no去重。
数据条件　operate_branch_num是操作结算方，不能代替归属门店。
频率与管理动作　周 月｜A；核查门店费用归属及往来性质。
08 03 客户费用收支
采集接口与来源　D05 客户费用
使用字段　client_fid/other_inout_kind/other_inout_flag/other_inout_money
计算公式　应收＝Σmoney(flag=true)；应付＝Σmoney(flag=false)；净费用＝应付−应收。
关联与粒度　client_fid＋项目＋审核期间；other_inout_bill_no去重。
数据条件　保留客户ID前导零，不按客户名近似归并。
频率与管理动作　周 月｜A；核对客户补贴、补损和重复单据。
08 04 供应商费用收支
采集接口与来源　D06 供应商费用
使用字段　supplier_num/expense_type/direction/amount
计算公式　按供应商和项目分别Σ应收、Σ应付；净费用＝应付−应收。
关联与粒度　supplier_num＋费用项目＋审核期；bill_no去重。
数据条件　此前接口业务不可用；采购净额不得当作供应商费用或应付余额。
频率与管理动作　周 月｜C；检查费用与合同条件。
08 05 费用后贡献率
采集接口与来源　D01 配送出库；D02 批发销售；D03 批发退货；D04 门店费用；D05 客户费用；D12 门店档案；D13 客户档案；X01 组织与营业日历
使用字段　D01.total_money；D02.wholesale_order_total_money；D03.wholesale_return_total_money；D01.items.cost_subtotal；D02.wholesale_order_cost_money；D03.wholesale_return_cost_money；D04.amount/direction/expense_type；D05.other_inout_money/other_inout_flag/other_inout_kind
计算公式　N＝R－C－E；贡献率＝N/R×100%。
关联与粒度　先按门店或客户分别聚合业务与费用，再按对象ID和期间连接。
数据条件　不按单据逐行连接全部费用，避免一对多放大；审核发生费用不自动等于该期会计费用。
频率与管理动作　月｜B；提供约定范围的管理利润分析。
08 06 应收应付期末余额
采集接口与来源　D02 批发销售；D03 批发退货；D04 门店费用；D05 客户费用；D06 供应商费用；D18 客户结算单；D19 客户收款单；D20 客户预收单；X05 财务期初资金与核销
使用字段　业务发生单；结算details.detail_fid；预收冲抵；期初与全量核销
计算公式　各往来科目期末＝期初＋本期增加−本期冲销/核销±调整。应收、应付和预收分开滚动；余额勾稽差＝计算期末−总账期末。
关联与粒度　对象ID＋业务域＋科目＋原单号；核销与现金为不同层次，一笔只抵减一次。
数据条件　供应商货款应付还缺全量采购应付及付款链；不可用采购汇总或amount−paid直接充当完整余额。
频率与管理动作　月｜C；形成可对账余额，避免以发生额代替。
08 07 到期及逾期金额
采集接口与来源　D18 客户结算单；D19 客户收款单；D20 客户预收单；X04 合同与商业条件；X05 财务期初资金与核销
使用字段　D18.settlement_details.payment_date；经核实未清金额；合同due_date
计算公式　到期金额＝Σ报告日前到期且仍未清金额；逾期金额筛due_date<报告日；逾期天数＝max(报告日−due_date,0)。
关联与粒度　原业务单/结算单→合同到期日→截至报告日核销；按对象分组。
数据条件　先重建报告日未清余额；当前未清字段不一定等于历史时点余额。供应商侧需X05补齐。
频率与管理动作　日 周｜C；安排催收、付款与资金计划。
08 08 现金收付及核销差异
采集接口与来源　D19 客户收款单；D20 客户预收单；D18 客户结算单；X05 财务期初资金与核销
使用字段　collection_total_money/collection_pre_money/payment_details；预收登记；银行流水及核销分配
计算公式　现金勾稽差＝已核实银行收付额−匹配业务现金收付额；核销差＝业务清偿额−核销分配额。预收冲应收只影响余额，不再次计现金。
关联与粒度　流水号＋账号＋金额＋日期＋原单引用；自动匹配不确定部分人工确认。
数据条件　D19审核状态文档为2；收款日期过滤须验证；没有资金流水不能确认到账。
频率与管理动作　日 月｜C；避免把审核或结算状态当作现金到账。
08 09 费用异常复核
采集接口与来源　D04 门店费用；D05 客户费用；D06 供应商费用；X08 口径阈值与商品范围；X03 整改与复核台账
使用字段　费用域、单号、对象ID、项目、方向、金额、审核日期、原单号、备注
计算公式　候选规则＝同对象/项目/方向/金额且日期差≤批准窗口，或同有效原单号重复；金额按候选涉及的唯一费用单汇总；确认率＝人工确认问题数/已复核候选数。
关联与粒度　单据主键使用费用域＋单号；比对关联原单、负数冲回及结算情况；X03记确认。
数据条件　候选配对不能重复加总同一单金额；候选不是违规。无D06时明确供应商费用未覆盖。
频率与管理动作　日 周｜A/B；生成待核清单，不直接定性违规。

公共计算定义
R　出库净额R＝ΣD01.total_money＋ΣD02.wholesale_order_total_money－ΣD03.wholesale_return_total_money。销售与退货统一符号后计算；配送负数保留。
C　成本C＝ΣD01.items.cost_subtotal＋ΣD02.wholesale_order_cost_money－ΣD03.wholesale_return_cost_money。单头与明细不得同时相加；null不当0。
G　毛利G＝R－C；毛利率＝G/R×100%。金额与成本税基须核定。
E　门店费应付EPb＝ΣD04.amount(direction=应付)，应收ERb＝ΣD04.amount(direction=应收)；客户费EPc＝ΣD05.other_inout_money(flag=false)，ERc同字段(flag=true)。净费用E＝EPb＋EPc－ERb－ERc；各金额保留红字。
N　费用后贡献N＝G－E；贡献率＝N/R×100%。不含工资、租金等全量成本，不等于会计净利润。
P　采购净额P＝ΣD11.money_total。同步核对money_total与purchase_item_money、purchase_present_money、purchase_item_return_money的系统关系，未确认赠品是否纳入时不能擅自重算替代。
A　采购加权价A＝ΣD11.purchase_item_money/ΣD11.purchase_item_amount。同商品同规格同基本单位；购入与退货分开，不以净数量求购入单价。
L　零售商品净额L＝ΣD07.sale_money－ΣD07.return_money。与D08/D09的含券和不含券口径分别核验，不跨报表直接混作同一分母。
Q　补损净费用Q按D04.expense_type或D05.other_inout_kind筛批准补损项目，再按E的方向计算。缺归因时只能到门店/客户，不能直接分给商品或供应商。
T　所有比例在分母为0时标不适用；分母为负时单列退货/冲回期，避免常规率排名。先按各自粒度聚合再关联，缺失数据标未取得。
采集接口及补充来源字典
D01 配送出库
接口　POST nhsoft.ama.ai.transfer.out.order.find
采集参数　start_date/end_date为制单日期；state_codes=[3]；page_number/page_size≤100。结果再按audit_time筛报告期。
已核字段　order_no, out_branch_num, branch_num, audit_time, create_time, state_code, total_money, related_order_no, items.item_num, items.out_money, items.cost_subtotal, items.out_quantity, items.in_quantity, items.lot_number, items.item_unit
使用边界　以out_branch_num识别发货中心，branch_num是收货门店。拉全分页；单据items最多200行。制单窗口不等于审核窗口，跨期漏单须补查。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.ama.ai.transfer.out.order.find
D02 批发销售
接口　POST nhsoft.whs.ai.wholesaleorder.find
采集参数　date_start/date_end；date_type=审核时间；state_codes=[3]；with_details=true；paging=true，offset/limit。
已核字段　wholesale_order_fid, branch_num, client_fid, region_num, state.state_code, wholesale_order_audit_time, wholesale_order_total_money, wholesale_order_cost_money, wholesale_order_details.item_num, wholesale_order_details.order_detail_num, wholesale_order_details.order_detail_money, wholesale_order_details.order_detail_cost, wholesale_order_details.order_detail_qty, wholesale_order_details.order_detail_present_qty, wholesale_order_details.order_detail_lot_number
使用边界　既有实测需按不超过7天分段，再合并去重。商品成本需包含赠品并核对单头，不把单头金额重复到每条商品行。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.whs.ai.wholesaleorder.find
D03 批发退货
接口　POST nhsoft.whs.ai.wholesalereturn.find
采集参数　日期、审核状态、明细及分页参数同D02；分别拉销售与退货。
已核字段　wholesale_return_fid, wholesale_order_fid, branch_num, client_fid, wholesale_return_audit_time, wholesale_return_total_money, wholesale_return_cost_money, wholesale_return_details.item_num, wholesale_return_details.return_detail_money, wholesale_return_details.return_detail_cost_money
使用边界　退货金额按该接口实际符号确认后统一为扣减口径；不得同时在销售红字和退货接口重复扣减。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.whs.ai.wholesalereturn.find
D04 门店费用
接口　POST nhsoft.ama.ai.branch.expense.find
采集参数　date_from/date_to为审核时间；state_code=3；page_number/page_size≤200；可筛branch_nums、operate_branch_nums。
已核字段　bill_no, branch_num, operate_branch_num, audit_time, expense_type, direction, amount, reference_bill, due_amount, paid_amount, settlement_state_name, memo
使用边界　归属用branch_num，总仓结算方用operate_branch_num。已核销费用仍计审核发生；paid_amount不可直接作为真实现金。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.ama.ai.branch.expense.find
D05 客户费用
接口　POST nhsoft.whs.ai.otherinout.find
采集参数　date_start/date_end；date_type=审核时间；state_code=3；paging=true，offset/limit。
已核字段　other_inout_bill_no, branch_num, client_fid, other_inout_audit_time, other_inout_kind, other_inout_flag, other_inout_money, other_inout_ref_bill, other_inout_paid_money, settlement_state_name
使用边界　other_inout_flag=true应收、false应付，金额保留红字；文档允许审核2或3，当前业务口径取3并核对返回状态名。业务机构不等于客户所属战区。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.whs.ai.otherinout.find
D06 供应商费用
接口　POST nhsoft.ama.ai.supplier.expense.find
采集参数　date_from/date_to；date_type=审核时间；state_code=3；page_number/page_size≤200。
已核字段　bill_no, supplier_num, branch_num, audit_time, expense_type, direction, amount, reference_bill, paid_amount, settlement_state_name
使用边界　目录与字段已确认；此前业务调用返回接口不存在。上线前复测，失败则使用同口径系统导出，绝不能记零。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.ama.ai.supplier.expense.find
D07 零售销售
接口　POST nhsoft.report.ai.itemsales.find
采集参数　bizday_start/bizday_end≤31天；branch_nums≤100；summary_types最多2维，如branch+bizday或branch+item。
已核字段　branch_num, bizday, item_num, sale_money, return_money, sale_num, return_num, sale_count
使用边界　sale_count为商品销售次数，不能当作有效订单数。门店商品日三维需按日或按店分批，并保留查询参数补足粒度。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.report.ai.itemsales.find
D08 零售毛利
接口　POST nhsoft.report.ai.itemprofitanalysis.find
采集参数　营业日期与门店范围同D07；summary_types=branch+item等；成本字段需对应查询权限。
已核字段　branch_num, item_num, bizday, sale_money, sale_money_no_coupon, sale_cost, profit_money, profit_money_no_coupon
使用边界　含券和不含券成对使用。优先用profit_money_no_coupon/ sale_money_no_coupon；缺字段不补零，不用配送成本替代零售成本。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.report.ai.itemprofitanalysis.find
D09 客单分析
接口　POST nhsoft.report.ai.customeranalysissummary.find
采集参数　营业日期与门店范围同D07；summary_types=branch+bizday或branch，不按商品/品类切片后累加客单。
已核字段　branch_num, bizday, receive_money, receipt_coupon_share_money, customer_nums, customer_ave_price_no_coupon
使用边界　不含券客单价用receive_money/customer_nums；客单数在跨品类切片中可能重复。文档可用不代表本次已调用验证。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.report.ai.customeranalysissummary.find
D10 经营指标校验
接口　POST nhsoft.report.ai.branchindicator.find
采集参数　date_type=month，date取月内日期；metrics按需选transfer_money、transfer_profit、order_count等；branch_nums≤100。
已核字段　branch_num, branch_region_num, branch_region_name, metric, actual_value, target_value
使用边界　metric与actual_value为长表。transfer_profit只作同范围对照，不覆盖出库单成本；系统目标覆盖情况需检查。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.report.ai.branchindicator.find
D11 采购分析
接口　POST nhsoft.report.ai.itempurchase.find
采集参数　audit_date_start/audit_date_end≤31天；branch_nums≤100；summary_types=supplier+item；部门筛item_departments。
已核字段　supplier_num, branch_num, item_num, base_unit, purchase_item_amount, purchase_item_money, purchase_present_amount, purchase_present_money, purchase_item_return_amount, purchase_item_return_money, money_total
使用边界　采购收货不是采购订单。money_total与购入、赠品、退货分量先勾稽；同品按base_unit比较；不同维度查询结果不能重复相加。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.report.ai.itempurchase.find
D12 门店档案
接口　POST nhsoft.user.ai.branch.find
采集参数　page_number/page_size分页，按需branch_nums。
已核字段　branch_num, name, region_id, enable
使用边界　enable不等于实际营业或闭店状态。region_id需组织映射；历史战区要带生效日期，不能套用当前档案。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.user.ai.branch.find
D13 客户档案
接口　GET nhsoft.whs.ai.client.find
采集参数　GET读取客户档案。
已核字段　client_fid, client_name, branch_num, region_num, region_name
使用边界　client_fid按字符串保存前导零。此前区域名称与费用客户区域缺失；需X01映射，不能用客户建档机构作战区。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.whs.ai.client.find
D14 商品档案
接口　POST nhsoft.base.ai.item.find
采集参数　item_nums或item_departments筛选；page_number/page_size分页。
已核字段　item_num, item_name, item_department.item_department_name, item_category.category_name, item_specs.spec_num, item_specs.convert_rate, unit_name, made_in, valid_period
使用边界　按商品部门确定水果/标品/耗材；具体品种等级需规范属性。同一大类汇总与同规格价格比较是两种分组。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.base.ai.item.find
D15 要货单
接口　POST nhsoft.ama.ai.request.order.find
采集参数　start_date/end_date为制单时间；state_codes=[3]；page_number/page_size≤100。
已核字段　order_no, branch_num, audit_time, create_time, external_order_no, related_order_no, items.item_num, items.quantity, items.use_rate, items.item_unit
使用边界　items最多200行；达到上限时需检查截断。关联字段含义必须抽单核实，不能只凭商品+日期关联。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.ama.ai.request.order.find
D16 配送调入单
接口　POST nhsoft.ama.ai.transfer.in.order.find
采集参数　制单日期、审核状态与分页同D01；再按所需事件期筛选。
已核字段　order_no, related_order_no, branch_num, audit_time, items.item_num, items.in_quantity, items.out_quantity, items.lot_number
使用边界　related_order_no关联调出单；同一调出行可能分次调入。审核时间不自动等于实际签收时间。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.ama.ai.transfer.in.order.find
D17 库存快照
接口　POST nhsoft.ama.ai.inventory.snapshot.find
采集参数　bizday为快照日；branch_nums/storehouse_nums；page_number/page_size分页。
已核字段　bizday, branch_num, storehouse_num, item_num, inventory_quantity, inventory_money, item_unit
使用边界　没有批号和到期日字段；不能单独算批次临期。此前总仓覆盖不完整，余额需验证与库存账一致。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.ama.ai.inventory.snapshot.find
D18 客户结算单
接口　POST nhsoft.whs.ai.clientsettlement.find
采集参数　date_start/date_end；date_type=审核时间；state_code=3；paging=true，offset/limit。
已核字段　client_settlement_no, client_fid, client_settlement_total_money, settlement_details.detail_fid, settlement_details.payment_date, settlement_details.need_paid_money, settlement_details.paid_money, settlement_details.unpaid_money
使用边界　payment_date为约定付款日期候选，需与合同核验。详情缺失则使用已文档化read接口按单号补取，不能将单头总额当作期末余额。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.whs.ai.clientsettlement.find
D19 客户收款单
接口　POST nhsoft.whs.ai.clientcollection.find
采集参数　date_start/date_end；date_type=收款日期；state_code=2为文档审核状态；with_details=true；offset/limit。
已核字段　collection_no, client_fid, collection_date, collection_total_money, collection_pre_money, collection_details.detail_fid, collection_details.collection_money, payment_details.payment_money
使用边界　与出库审核3不同，需核验状态名。现金与预收冲抵分开，资金流水复核后确认现金；历史日期筛选曾有待核现象。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.whs.ai.clientcollection.find
D20 客户预收单
接口　POST nhsoft.whs.ai.clientpresettlement.find
采集参数　date_start/date_end；date_type按审核或收款目的选择；state_code=3；offset/limit。
已核字段　pre_settlement_no, client_fid, pre_settlement_date, pre_settlement_paid, pre_settlement_money, remain_money, pre_settlement_ref_bill_no
使用边界　预收登记不自动等于银行到账。历史批次剩余余额需全量期初和核销，不以本月登记余额代替全公司余额。
文档来源　https://agi.lemengcloud.com/ability/nhsoft.whs.ai.clientpresettlement.find
X01 组织与营业日历
接口　系统导出或受控台账 补充数据源 未确认可直接采集的乐檬接口
采集参数　企业组织档案和门店营业台账；字段为建议新增模型，不是已验证API字段。
建议字段　branch_num/client_fid→region_id→战区；effective_from/effective_to；opening_date/closing_date；business_day；is_open；数据完整标记。
使用边界　本编号中的字段为建议新增字段，禁止当作现有接口字段。
X02 活动与对照台账
接口　系统导出或受控台账 补充数据源 未确认可直接采集的乐檬接口
采集参数　活动管理系统或受控表；建立活动到销售及费用的映射。
建议字段　campaign_id、branch_num、item_num、开始结束日期、对照门店、基准毛利、增量投入、费用单号。
使用边界　本编号中的字段为建议新增字段，禁止当作现有接口字段。
X03 整改与复核台账
接口　系统导出或受控台账 补充数据源 未确认可直接采集的乐檬接口
采集参数　企业任务系统或受控表；发现、确认、处理、复核分别记录。
建议字段　issue_id、owner_id、due_at、verified_at、verify_status、rule_id、bill_no、impact_amount。
使用边界　本编号中的字段为建议新增字段，禁止当作现有接口字段。
X04 合同与商业条件
接口　系统导出或受控台账 补充数据源 未确认可直接采集的乐檬接口
采集参数　采购合同和客户合同系统；字段为建议模型。
建议字段　supplier_num/client_fid、合同号、计价单位、税费/运费/账期、rebate_base、rebate_rate、due_date、生效期。
使用边界　本编号中的字段为建议新增字段，禁止当作现有接口字段。
X05 财务期初资金与核销
接口　系统导出或受控台账 补充数据源 未确认可直接采集的乐檬接口
采集参数　财务总账、资金系统或银行对账单；本轮未确认可覆盖全部数据的乐檬API。
建议字段　往来对象、科目、期初余额、全量发生额、结算/核销金额、银行流水号、实际收付日、分配到业务单的金额。
使用边界　本编号中的字段为建议新增字段，禁止当作现有接口字段。
X06 WMS或TMS批次与事件
接口　系统导出或受控台账 补充数据源 未确认可直接采集的乐檬接口
采集参数　仓储运输系统或系统导出。不能用出库时商品库存字段当作报告日批次库存。
建议字段　原单号、行号、item_num、lot_number、批次在库数量/成本、expiration_date、dispatch_at、received_at、promised_at。
使用边界　本编号中的字段为建议新增字段，禁止当作现有接口字段。
X07 品质补损归因
接口　系统导出或受控台账 补充数据源 未确认可直接采集的乐檬接口
采集参数　售后/质检记录；一张费用单跨批次时，分配合计必须等于原单金额。
建议字段　费用单号、原出库单及行、item_num、supplier_num、lot_number、quality_flag、分配金额和证据。
使用边界　本编号中的字段为建议新增字段，禁止当作现有接口字段。
X08 口径阈值与商品范围
接口　系统导出或受控台账 补充数据源 未确认可直接采集的乐檬接口
采集参数　企业批准的配置表，不自行设定统一考核门槛。
建议字段　角色管理范围、标品/耗材清单、需批号商品标识、临期天数、低动销阈值、重复费用窗口、目标值和版本。
使用边界　本编号中的字段为建议新增字段，禁止当作现有接口字段。
X09 采集与勾稽日志
接口　系统导出或受控台账 补充数据源 未确认可直接采集的乐檬接口
采集参数　采集程序产生；用于区分真零数据、接口失败和未取全。
建议字段　接口、参数、执行时间、分页数、返回条数、字段缺失数、状态码、源端合计与取数合计。
使用边界　本编号中的字段为建议新增字段，禁止当作现有接口字段。
跨期完整性　配送、要货和调入接口按制单日筛选，不能只拉报告月制单后宣称覆盖全部报告月审核。需补查更早制单后本期审核记录，并与同范围汇总对账。
分页与明细　取得全部页并按业务域＋单号去重；items达到200行上限需核对明细完整性。read接口也可能有限制，不能未经验证就认为补读一定取全。
部署验收　每项应验证源端合计一致、主键唯一、映射覆盖、字段非空、状态/日期正确及明细与单头勾稽。部分可算指标不能冒充全范围指标。
