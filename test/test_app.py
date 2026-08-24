import unittest

import app as backend


class SketchResponseTests(unittest.TestCase):
    def setUp(self):
        with backend._resp_lock:
            backend.respuestas.clear()
            if hasattr(backend, "solicitudes_activas"):
                backend.solicitudes_activas.clear()
            if hasattr(backend, "solicitudes_pendientes"):
                backend.solicitudes_pendientes.clear()

    def test_raw_http_preserves_status_and_content_type_parameters(self):
        response = backend._responder_http(
            "HTTP/1.1 404 Not Found\r\n"
            "Content-Type: text/plain; charset=iso-8859-1\r\n\r\nmissing"
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.content_type, "text/plain; charset=iso-8859-1")
        self.assertEqual(response.get_data(as_text=True), "missing")

    def test_raw_http_does_not_rewrite_body_line_endings(self):
        response = backend._responder_http(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nfirst\r\nsecond"
        )
        self.assertEqual(response.get_data(), b"first\r\nsecond")

    def test_late_response_is_discarded(self):
        client = backend.app.test_client()
        response = client.post("/__sim/respuesta", json={"id": 999, "body": "late"})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()["accepted"])
        self.assertNotIn(999, backend.respuestas)

    def test_simulator_poll_delivers_concurrent_requests_in_order(self):
        with backend._resp_lock:
            backend.solicitudes_activas.update((10, 11))
            backend.solicitudes_pendientes.extend((
                {"request": "GET /first HTTP/1.1", "id": 10, "ts": 10.0},
                {"request": "GET /second HTTP/1.1", "id": 11, "ts": 11.0},
            ))
        client = backend.app.test_client()
        self.assertEqual(client.get("/__sim/estado").get_json()["id"], 10)
        self.assertEqual(client.get("/__sim/estado").get_json()["id"], 11)

    def test_timeout_removes_pending_request(self):
        original_timeout = backend.TIEMPO_RESPUESTA
        backend.TIEMPO_RESPUESTA = 0
        try:
            backend._registrar_comando("/timeout")
        finally:
            backend.TIEMPO_RESPUESTA = original_timeout
        self.assertEqual(backend.solicitudes_pendientes, [])
        self.assertEqual(backend.solicitudes_activas, set())


if __name__ == "__main__":
    unittest.main()
