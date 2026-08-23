import 'package:api_client/api_client.dart';
import 'package:test/test.dart';

void main() {
  group('ApiException.fromResponse', () {
    test('parses the contract error envelope', () {
      final error = ApiException.fromResponse(422, {
        'error': {
          'code': 'VALIDATION_FAILED',
          'message': 'bad input',
          'details': {'field': 'amount'},
          'traceId': 'trace-123',
        },
      });

      expect(error.code, 'VALIDATION_FAILED');
      expect(error.message, 'bad input');
      expect(error.details, {'field': 'amount'});
      expect(error.traceId, 'trace-123');
      expect(error.statusCode, 422);
    });

    test('falls back to INTERNAL for a body that is not the envelope', () {
      // e.g. an HTML error page from a proxy — the client must not surface its contents.
      final error = ApiException.fromResponse(502, '<html>gateway error at 10.0.0.5</html>');
      expect(error.code, 'INTERNAL');
      expect(error.message, 'Request failed');
      expect(error.toString(), isNot(contains('10.0.0.5')));
    });

    test('preserves an unrecognised code — a sideloaded client may be a version behind', () {
      final error = ApiException.fromResponse(400, {
        'error': {'code': 'SOME_FUTURE_CODE', 'message': 'from a newer server'},
      });
      expect(error.code, 'SOME_FUTURE_CODE');
    });

    test('flags the update-required case that gates old clients (rule 17)', () {
      final error = ApiException.fromResponse(426, {
        'error': {'code': 'UPDATE_REQUIRED', 'message': 'Please update'},
      });
      expect(error.requiresUpdate, isTrue);
    });

    test('distinguishes maintenance and auth failures for the UI', () {
      expect(
        ApiException.fromResponse(503, {
          'error': {'code': 'MAINTENANCE', 'message': 'down for maintenance'},
        }).isMaintenance,
        isTrue,
      );
      expect(
        ApiException.fromResponse(401, {
          'error': {'code': 'AUTH_TOKEN_EXPIRED', 'message': 'expired'},
        }).isAuthFailure,
        isTrue,
      );
    });
  });
}
