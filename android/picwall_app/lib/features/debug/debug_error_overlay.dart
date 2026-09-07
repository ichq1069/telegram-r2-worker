import 'package:flutter/material.dart';

import '../../services/debug_service.dart';

/// 调试模式下的错误浮层：右上角红色角标，点击展开最近错误列表。
class DebugErrorOverlay extends StatelessWidget {
  const DebugErrorOverlay({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: DebugService.instance,
      builder: (context, _) {
        final svc = DebugService.instance;
        if (!svc.enabled) return child;
        final count = svc.errors.length;
        return Stack(
          children: [
            child,
            if (count > 0)
              Positioned(
                top: MediaQuery.of(context).padding.top + 4,
                right: 8,
                child: GestureDetector(
                  onTap: () => _showErrors(context),
                  child: Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: Colors.red.shade700,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(
                      '$count 错误',
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
      },
    );
  }

  void _showErrors(BuildContext context) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (_) =>
          _ErrorListSheet(errors: DebugService.instance.errors),
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
