import 'dart:async';

import 'package:socket_io_client/socket_io_client.dart' as io;

/// Envelope mirroring the server's realtime protocol (P5).
class RealtimeEvent {
  const RealtimeEvent({
    required this.version,
    required this.seq,
    required this.type,
    required this.room,
    required this.timestamp,
    required this.payload,
  });

  final int version;

  /// Monotonic per room. The client tracks the highest applied value so it can resume.
  final int seq;
  final String type;
  final String room;
  final DateTime timestamp;
  final Map<String, dynamic> payload;

  factory RealtimeEvent.fromJson(Map<String, dynamic> json) => RealtimeEvent(
    version: json['v'] as int? ?? 1,
    seq: json['seq'] as int? ?? 0,
    type: json['type'] as String? ?? 'unknown',
    room: json['room'] as String? ?? '',
    timestamp: DateTime.fromMillisecondsSinceEpoch(json['ts'] as int? ?? 0),
    payload: (json['payload'] as Map<String, dynamic>?) ?? const {},
  );
}

enum RealtimeStatus { disconnected, connecting, connected, resyncRequired }

/// Socket.IO client for the `/game` namespace.
///
/// The client's only state is "the highest sequence I have applied". On reconnect it
/// tells the server that number and receives either the exact gap or an instruction to
/// resync — it never guesses at missing state, and it never treats its own view as
/// authoritative (rule 1).
class RealtimeClient {
  RealtimeClient({required this.baseUrl});

  /// Origin only, without the `/api/v1` prefix — Socket.IO attaches at the namespace.
  final String baseUrl;

  io.Socket? _socket;
  final _events = StreamController<RealtimeEvent>.broadcast();
  final _status = StreamController<RealtimeStatus>.broadcast();

  /// Highest applied sequence per room, the basis of every resume request.
  final Map<String, int> _lastSeq = {};

  Stream<RealtimeEvent> get events => _events.stream;
  Stream<RealtimeStatus> get status => _status.stream;

  int lastSeqFor(String room) => _lastSeq[room] ?? 0;

  /// Connects with a single-use ticket obtained from `POST /realtime/ticket`.
  Future<void> connect(String ticket) async {
    disconnect();
    _status.add(RealtimeStatus.connecting);

    final socket = io.io(
      '$baseUrl/game',
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'ticket': ticket})
          // Reconnection is driven by the app, not the socket library: a new connection
          // needs a NEW ticket (they are single-use), so blind auto-reconnect would
          // retry with a consumed one and fail every time.
          .disableAutoConnect()
          .disableReconnection()
          .build(),
    );

    socket.onConnect((_) => _status.add(RealtimeStatus.connected));
    socket.onDisconnect((_) => _status.add(RealtimeStatus.disconnected));
    socket.on('room:event', (data) {
      if (data is! Map) return;
      final event = RealtimeEvent.fromJson(Map<String, dynamic>.from(data));
      // Out-of-order or duplicate deliveries are dropped rather than applied twice.
      if (event.seq <= lastSeqFor(event.room)) return;
      _lastSeq[event.room] = event.seq;
      _events.add(event);
    });
    socket.on('resync:required', (_) => _status.add(RealtimeStatus.resyncRequired));

    socket.connect();
    _socket = socket;
  }

  Future<bool> joinRoom(String room) async {
    final ack = await _emitWithAck('room:join', {'room': room});
    if (ack?['ok'] == true) {
      // Adopt the server's current sequence: anything before joining is not ours to replay.
      _lastSeq[room] = (ack?['seq'] as int?) ?? 0;
      return true;
    }
    return false;
  }

  /// Leaves a room. The sequence is forgotten with it: a later re-join adopts the
  /// server's current sequence rather than trying to resume from a stale one.
  Future<void> leaveRoom(String room) async {
    await _emitWithAck('room:leave', {'room': room});
    _lastSeq.remove(room);
  }

  /// Resumes a room after a reconnect. Returns the number of replayed events, or null
  /// when the server demands a full resync.
  Future<int?> resume(String room) async {
    final ack = await _emitWithAck('resume', {'room': room, 'lastSeq': lastSeqFor(room)});
    if (ack?['resync'] == true) {
      _lastSeq.remove(room);
      _status.add(RealtimeStatus.resyncRequired);
      return null;
    }
    return (ack?['replayed'] as int?) ?? 0;
  }

  Future<Map<String, dynamic>?> _emitWithAck(String event, Map<String, dynamic> body) {
    final socket = _socket;
    if (socket == null) return Future.value(null);

    final completer = Completer<Map<String, dynamic>?>();
    socket.emitWithAck(
      event,
      body,
      ack: (dynamic response) {
        if (!completer.isCompleted) {
          completer.complete(response is Map ? Map<String, dynamic>.from(response) : null);
        }
      },
    );
    return completer.future.timeout(
      const Duration(seconds: 10),
      onTimeout: () => null,
    );
  }

  void disconnect() {
    _socket?.dispose();
    _socket = null;
    _status.add(RealtimeStatus.disconnected);
  }

  void dispose() {
    disconnect();
    _events.close();
    _status.close();
  }
}
