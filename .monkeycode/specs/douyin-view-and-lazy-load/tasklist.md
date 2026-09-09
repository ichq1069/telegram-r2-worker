# Tasklist

## Phase 0: 前置与规格定稿

- [x] 澄清需求范围(懒加载范围=四类列表虚拟化+图片视口懒加载;抖音入口=图库/发现顶栏;交互=静音自动播+点开声+右侧操作栏+contain 适配+上滑加载更多)
- [x] 产出 requirements.md / design.md
- [x] commit + push 规格定稿(触发 git 提交,android/specs 均不触发 CI)

## Phase 1: 懒加载虚拟化容器与四列表接入

- [x] 新建 `lib/features/gallery/masonry_virtual_grid.dart`:双列分行虚拟化容器(SliverList+Row,奇数尾行占位,预估行高,footer 追加行,cacheExtent 可配)
- [x] 抽出纯函数(行分组/奇数补位/预估行高/去重),保证可单测
- [x] `paged_media_grid.dart`(图库):Wrap 替换为 MasonryVirtualGrid,分页状态与触底加载保留
- [x] `discover_page.dart`:Wrap 替换为 MasonryVirtualGrid
- [x] `my_files_page.dart`:Wrap 替换为 MasonryVirtualGrid(长按删除/打标保留)
- [x] `local_grid_page.dart`:Wrap 替换为 MasonryVirtualGrid(移除/清空保留)
- [ ] 校验:滚动触底加载、下拉刷新、空态/错误态、视频槽位自动播放、奇数条尾行视觉
- [ ] commit + push(触发 build-android.yml 编译验证 Dart)

## Phase 2: DetailActionsMixin 抽取与 DetailPage 重构

- [ ] 新建 `lib/features/detail/detail_actions.dart`:从 DetailPage 抽取 历史记录/收藏态/保存图片/下载视频/分享/详情面板/直链补全 为 ConsumerState 混入
- [ ] DetailPage 改为混入,删除私有重复方法,行为等价(标签跳转保留为宿主可配置回调,抖音默认不跳转)
- [ ] 校验:详情页收藏/保存/分享/详情/复制仍工作;flutter analyze 无告警
- [ ] commit + push(触发 build-android.yml)

## Phase 3: NativeVideoPlayer 点击开声能力

- [ ] `native_video_player.dart` 增加 `showTapToUnmute`(controls:false 静音时整画面手势层,点击 _toggleMute,音量图标浮层指示);SoftwareVideo 透传 muted
- [ ] 校验:软解/硬解路径下点击开声、切页停止释放
- [ ] commit + push(触发 build-android.yml)

## Phase 4: 抖音视图 DouyinViewPage

- [ ] 新建 `lib/features/douyin/douyin_view_page.dart`:竖向 PageView.builder + 当前屏视频 NativeVideoPlayer(poster 邻屏占位) / 图片 contain+渐变信息层 + 右侧操作栏(收藏/保存/分享/详情/下载视频) + 上滑近尾加载更多 + 空态/错误/到底提示
- [ ] 图库 `GalleryPage`:AppBar 抖音入口(列表非空可点),按当前过滤构造 loadPage 闭包
- [ ] 发现 `DiscoverPage`:AppBar 抖音入口(列表非空可点),randomPool 续批 + dedupeKey 去重 loadPage
- [ ] 校验:带过滤进入、切页播放暂停、点开声、收藏/保存/分享/详情、返回列表位置保持、上滑续载至 total/去重尽
- [ ] commit + push(触发 build-android.yml 编译验证)

## Phase 5: 单测与收尾

- [ ] 新增纯逻辑单测:行分组(0/1/2/5 条)、奇数尾行、cell 宽公式、去重合并;跑 `flutter test`(若环境可)或交由 CI
- [ ] 回归走查:四列表格滚动/自动播放/刷新/长按;详情页操作等价;抖音视图端到端
- [ ] 最终 commit + push;确认 build-android.yml 绿
