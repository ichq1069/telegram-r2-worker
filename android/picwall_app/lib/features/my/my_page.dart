import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants.dart';
import '../../data/models/user.dart';
import '../../services/providers.dart';
import '../auth/login_page.dart';
import '../auth/session_controller.dart';
import '../library/local_grid_page.dart';
import '../upload/upload_page.dart';
import 'my_files_page.dart';

/// 我的：资料卡（级别/到期/配额）+ 我的图片/收藏/历史 + 设置 + 退出。
class MyPage extends ConsumerStatefulWidget {
  const MyPage({super.key});

  @override
  ConsumerState<MyPage> createState() => _MyPageState();
}

class _MyPageState extends ConsumerState<MyPage> {
  QuotaInfo? _quota;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadQuota());
  }

  Future<void> _loadQuota() async {
    try {
      final q = await ref.read(galleryRepositoryProvider).quota();
      if (mounted) setState(() => _quota = q);
    } catch (_) {
      // 配额展示失败不阻塞页面
    }
  }

  void _push(Widget page) {
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));
  }

  Future<void> _openUpload() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const UploadPage()),
    );
    await _loadQuota();
  }

  void _openSettings() {
    // TODO: 完整设置页见 T4.2；本轮提供退出与服务器信息占位。
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('完整设置页将在后续版本提供')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final sessionCtl = ref.watch(sessionControllerProvider);
    final session = sessionCtl.session;
    if (session == null) return const LoginPage();

    return Scaffold(
      appBar: AppBar(title: const Text('我的')),
      body: RefreshIndicator(
        onRefresh: _loadQuota,
        child: ListView(
          children: [
            _ProfileCard(session: session, quota: _quota),
            const SizedBox(height: 8),
            _entry(Icons.cloud_upload_outlined, '上传图片', _openUpload),
            _entry(Icons.photo_outlined, '我的图片', () => _push(const MyFilesPage())),
            _entry(Icons.favorite_outline, '我的收藏', () => _push(const LocalGridPage(
                  title: '我的收藏',
                  kind: LocalKind.favorite,
                  emptyText: '还没有收藏，在详情页点 ♥ 收藏',
                ))),
            _entry(Icons.history, '浏览历史', () => _push(const LocalGridPage(
                  title: '浏览历史',
                  kind: LocalKind.history,
                  emptyText: '还没有浏览记录',
                ))),
            _entry(Icons.settings_outlined, '设置', _openSettings),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.logout, color: Color(0xFFE53935)),
              title: const Text('退出登录', style: TextStyle(color: Color(0xFFE53935))),
              onTap: () async {
                await ref.read(sessionControllerProvider).logout();
              },
            ),
            const SizedBox(height: 24),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(
                'API：${ref.watch(settingsControllerProvider).settings.apiBase}',
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  fontSize: 11,
                ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _entry(IconData icon, String title, VoidCallback onTap) {
    return ListTile(
      leading: Icon(icon),
      title: Text(title),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    );
  }
}

class _ProfileCard extends StatelessWidget {
  const _ProfileCard({required this.session, this.quota});

  final UserSession session;
  final QuotaInfo? quota;

  @override
  Widget build(BuildContext context) {
    final s = session;
    final q = quota;

    return Card(
      margin: const EdgeInsets.all(12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 26,
                  backgroundColor: Theme.of(context).colorScheme.primary.withValues(alpha: 0.2),
                  child: Text(
                    s.username.isNotEmpty ? s.username[0].toUpperCase() : 'U',
                    style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        s.name.isNotEmpty ? s.name : s.username,
                        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 4),
                      Wrap(
                        spacing: 8,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          _LevelChip(level: s.level),
                          if (s.expiresAt.isNotEmpty)
                            Text(
                              '到期 ${s.expiresAt}',
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
            if (q != null && q.uploadQuota > 0) ...[
              const SizedBox(height: 16),
              Text(
                '上传配额 ${q.uploadUsed} / ${q.uploadQuota} 张',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 6),
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: q.ratio,
                  minHeight: 6,
                  backgroundColor: Colors.white12,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                '存储已用 ${_fmtBytes(q.storageUsed)}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ],
        ),
      ),
    );
  }

  static String _fmtBytes(int bytes) {
    if (bytes >= 1024 * 1024 * 1024) {
      return '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(2)} GB';
    }
    if (bytes >= 1024 * 1024) {
      return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
    }
    if (bytes >= 1024) {
      return '${(bytes / 1024).toStringAsFixed(0)} KB';
    }
    return '$bytes B';
  }
}

class _LevelChip extends StatelessWidget {
  const _LevelChip({required this.level});

  final UserLevel level;

  @override
  Widget build(BuildContext context) {
    final color = level == UserLevel.vvip
        ? const Color(0xFFE91E63)
        : level == UserLevel.svip
            ? const Color(0xFF7C4DFF)
            : level == UserLevel.vip
                ? const Color(0xFF29B6F6)
                : Colors.white24;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        level.label,
        style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700),
      ),
    );
  }
}
