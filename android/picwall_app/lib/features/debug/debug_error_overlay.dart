import 'package:flutter/material.dart';

import '../services/debug_service.dart';

/// 调试模式下的错误浮层：右上角红色角标，点击展开最近错误列表。
class DebugErrorOverlay extends StatefulWidget {
  const DebugErrorOverlay({super.key, required this.child});

  final Widget child;

  @override
  State<DebugErrorOverlay> createState() => _DebugErrorOverlayState();
}

class _DebugErrorOverlayState extends State<DebugErrorOverlay> {
  final _svc = DebugService.instance;
  int _count = 0;

  @override
  void initState() {
    super.initState();
    _svc.errorStream.listen((_) {
      if (mounted) setState(() => _count = _svc.errors.length);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        widget.child,
        if (_svc.enabled && _count > 0)
          Positioned(
            top: MediaQuery.of(context).padding.top + 4,
            right: 8,
            child: GestureDetector(
              onTap: _showErrors,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: Colors.red.shade700,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  '$_count 错误',
                  style: const TextStyle(
                      color: Colors.white,
                      fontSize: 11,
                      fontWeight: FontWeight.w600),
                ),
              ),
            ),
          ),
      ],
    );
  }

  void _showErrors() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (_) => _ErrorListSheet(errors: _svc.errors),
    );
  }
}

class _ErrorListSheet extends StatelessWidget {
  const _ErrorListSheet({required this.errors});

  final List<DebugError> errors;

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      initialChildSize: 0.6,
      minChildSize: 0.3,
      maxChildSize: 0.9,
      expand: false,
      builder: (ctx, ctrl) => Scaffold(
        appBar: AppBar(
          title: const Text('调试错误'),
          actions: [
            TextButton(
              onPressed: () {
                DebugService.instance.clear();
                Navigator.pop(ctx);
              },
              child: const Text('清空',
                  style: TextStyle(color: Colors.white70)),
            ),
          ],
        ),
        body: errors.isEmpty
            ? const Center(child: Text('暂无错误'))
            : ListView.builder(
                controller: ctrl,
                itemCount: errors.length,
                itemBuilder: (_, i) {
                  final e = errors[i];
                  return ExpansionTile(
                    title: Text('[${e.timeStr}] ${e.source}',
                        style: const TextStyle(fontSize: 13)),
                    subtitle: Text(e.message,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12)),
                    children: [
                      if (e.stack != null)
                        Padding(
                          padding: const EdgeInsets.all(12),
                          child: Text(e.stack!,
                              style: const TextStyle(
                                  fontSize: 11, fontFamily: 'monospace')),
                        ),
                    ],
                  );
                },
              ),
      ),
    );
  }
}
