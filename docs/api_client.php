<?php
/**
 * Test Client for the RESTful API Wrapper
 * This script sends curl requests to verify each endpoint.
 */

// Define the base URL of the local RESTful API server
// Adjust if you start the server on a different port or host.
$apiBaseUrl = 'http://127.0.0.1:7700/api.php';

echo "RESTful API Tester running against: " . $apiBaseUrl . "\n";

/**
 * Send an HTTP Request using cURL
 */
function sendRequest($method, $path, $data = null)
{
    global $apiBaseUrl;
    $url = $apiBaseUrl . $path;

    if ($method === 'GET' && !empty($data)) {
        $url .= '?' . http_build_query($data);
    }

    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, strtoupper($method));
    curl_setopt($ch, CURLOPT_TIMEOUT, 15);

    $headers = [];
    if ($method === 'POST') {
        $payload = json_encode($data);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        $headers[] = 'Content-Type: application/json';
        $headers[] = 'Content-Length: ' . strlen($payload);
    } else {
        $headers[] = 'Accept: application/json';
    }

    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);

    $responseBody = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    return [
        'url' => $url,
        'method' => $method,
        'http_code' => $httpCode,
        'error' => $error,
        'raw' => $responseBody,
        'json' => json_decode($responseBody, true)
    ];
}

/**
 * Print details of the test execution
 */
function printResult($title, $result)
{
    echo "\n============================================\n";
    echo "TEST: " . $title . "\n";
    echo "Request: " . $result['method'] . " " . $result['url'] . "\n";
    echo "HTTP Status Code: " . $result['http_code'] . "\n";

    if ($result['error']) {
        echo "cURL Error: " . $result['error'] . "\n";
    }

    if (is_array($result['json'])) {
        echo json_encode($result['json'], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n";
    } else {
        echo "Raw Response:\n" . $result['raw'] . "\n";
    }
}

// --- START TESTS ---

// // 1. GET /tien-nuoc
// $res1 = sendRequest('GET', '/tien-nuoc', [
//     'danhba' => '15052170779',
//     'ky' => 4,
//     'nam' => 2026
// ]);
// printResult('1. Tra cứu tiền nước', $res1);

// 2. GET /san-luong
// $res2 = sendRequest('GET', '/san-luong', [
//     'danhba' => '15122890724',
//     'ky' => 3,
//     'nam' => 2025
// ]);
// printResult('2. Tra cứu sản lượng', $res2);

// // 3. GET /so-sanh-tang-giam
// $res3 = sendRequest('GET', '/so-sanh-tang-giam', [
//     'danhba' => '15052170779',
//     'ky' => 3,
//     'nam' => 2026
// ]);
// printResult('3. So sánh tăng giảm', $res3);

// // 4. GET /cup-nuoc
// $res4 = sendRequest('GET', '/cup-nuoc', [
//     'danhba' => '15052170779'
// ]);
// printResult('4. Thông báo cúp nước', $res4);

// // 5. GET /thong-tin-khach-hang
$res5 = sendRequest('GET', '/thong-tin-khach-hang', [
    'sdt' => '09084863261'
]);
printResult('5. Thông tin khách hàng', $res5);


// 15122890724
// 5. GET /thong-tin-khach-hang theo danh ba
$res5 = sendRequest('GET', '/thong-tin-khach-hang', [
    'danhba' => '151228907241'
]);
printResult('5. Thông tin khách hàng theo danh ba', $res5);
// // 6. POST /bao-su-co
// $res6 = sendRequest('POST', '/bao-su-co', [
//     'danhba' => '15052170779',
//     'noidung' => 'Khach hang bao ap luc nuoc yeu'
// ]);
// printResult('6. Báo sự cố', $res6);

// // 7. GET /invalid-endpoint (Should return 404)
// $res7 = sendRequest('GET', '/khong-ton-tai');
// printResult('7. Sai đường dẫn (404)', $res7);

// // 8. GET /tien-nuoc (Missing parameter danhba - Should return 400)
// $res8 = sendRequest('GET', '/tien-nuoc');
// printResult('8. Thiếu tham số bắt buộc (400)', $res8);
