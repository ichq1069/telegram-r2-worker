import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../services/api_client.dart';
import '../../services/providers.dart';
import 'admin_shell.dart';

/// 管理模式门：输入服务器主 API Key（env.API_KEY）验证后进入管理壳。
///
/// 入口：我的页连续点击 5 次版本号。校验规则与 worker 一致（`api_key` 直连，
/// 不附带用户密钥，noKey）。key 通过后持久化到 settings.adminKey，后续进入自动验证。
class AdminPage extends ConsumerStatefulWidget {
  const AdminPage({super.key});

  @override
  ConsumerState<AdminPage> createState() => _AdminPageState();
}

class _AdminPageState extends ConsumerState<AdminPage> {
  final _keyCtrl = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final key = ref.read(settingsControllerProvider).settings.adminKey;
      if (key.isNotEmpty) {
        _keyCtrl.text = key;
        _verify(key);
      }
    });
  }

  @override
  void dispose() {
    _keyCtrl.dispose();
    super.dispose();
  }

  Future<void> _verify(String key) async {
    if (_busy || key.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(galleryRepositoryProvider).adminStats(key);
      await ref.read(settingsControllerProvider).saveAdminKey(key);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(
          builder: (_) => AdminShellPage(adminKey: key),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = normalizeError(e).toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('管理模式')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('输入服务器主 API Key 开启管理后台',
                      style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                  const SizedBox(height: 6),
                  const Text('与网页后台一致，校验 env.API_KEY；验证通过后 Key 会保存在本机，'
                      '下次进入自动放行。',
                      style: TextStyle(fontSize: 13)),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _keyCtrl,
                    obscureText: true,
                    autofocus: false,
                    decoration: const InputDecoration(
                      labelText: '主 API Key',
                      hintText: '服务器主密钥',
                      isDense: true,
                      border: OutlineInputBorder(),
                    ),
                    onSubmitted: (_) => _verify(_keyCtrl.text.trim()),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 8),
                    Text(_error!,
                        style: TextStyle(color: theme.colorScheme.error, fontSize: 12)),
                  ],
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                      onPressed: _busy ? null : () => _verify(_keyCtrl.text.trim()),
                      icon: _busy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.admin_panel_settings_outlined),
                      label: const Text('验证并进入'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
