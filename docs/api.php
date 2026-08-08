<?php
/**
 * RESTful API Endpoint Router for TongDaiApiClient
 * Exposes methods of TongDaiApiClient as standard JSON endpoints.
 */

// Enable CORS and define response headers
header("Access-Control-Allow-Origin: *");
header("Content-Type: application/json; charset=UTF-8");
header("Access-Control-Allow-Methods: OPTIONS, GET, POST");
header("Access-Control-Max-Age: 3600");
header("Access-Control-Allow-Headers: Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With");

// Handle CORS preflight requests
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

require_once __DIR__ . '/TongDaiApiClient.php';

// Helper function to send uniform JSON responses
function sendResponse($success, $data = null, $error = null, $httpCode = 200)
{
    http_response_code($httpCode);
    $response = [
        'success' => $success,
        'http_code' => $httpCode
    ];
    if ($error !== null) {
        $response['error'] = $error;
    }
    if ($data !== null) {
        $response['data'] = $data;
    }
    echo json_encode($response, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
    exit();
}

// Extract path info
$path = isset($_SERVER['PATH_INFO']) ? trim($_SERVER['PATH_INFO'], '/') : '';
if (empty($path)) {
    $requestUri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    $scriptName = $_SERVER['SCRIPT_NAME'];
    if (strpos($requestUri, $scriptName) === 0) {
        $path = substr($requestUri, strlen($scriptName));
    } else {
        $path = basename($requestUri);
    }
    $path = trim($path, '/');
}

// If no endpoint is specified
if (empty($path)) {
    sendResponse(false, [
        'available_endpoints' => [
            'GET /tien-nuoc' => 'Tra cứu thông tin tiền nước. Params: danhba (req), ky (opt), nam (opt)',
            'GET /san-luong' => 'Tra cứu lượng nước sử dụng. Params: danhba (req), ky (opt), nam (opt)',
            'GET /so-sanh-tang-giam' => 'So sánh tăng giảm sản lượng. Params: danhba (req), ky (opt), nam (opt)',
            'GET /cup-nuoc' => 'Thông báo lịch cúp nước. Params: danhba (req)',
            'GET /thong-tin-khach-hang' => 'Lấy thông tin khách hàng. Params: danhba (opt), sdt (opt) - ít nhất 1 tham số',
            'POST /bao-su-co' => 'Báo sự cố rò rỉ hoặc áp lực nước / ghi nhận lời nhắn. Body JSON: noidung (req), tel (opt), danhba (opt — không bắt buộc từ 07/08/2026)'
        ]
    ], 'No API endpoint specified. Please refer to available endpoints.', 400);
}

// Instantiate the TongDaiApiClient
// Using defaults or configurations if defined
$client = new TongDaiApiClient('https://10.10.10.155:1273', 30, false);
$method = $_SERVER['REQUEST_METHOD'];

switch ($path) {
    case 'tien-nuoc':
        if ($method !== 'GET') {
            sendResponse(false, null, 'Method Not Allowed. Only GET requests are supported.', 405);
        }

        $danhba = isset($_GET['danhba']) ? trim($_GET['danhba']) : '';
        if (empty($danhba)) {
            sendResponse(false, null, 'Parameter "danhba" is required and cannot be empty.', 400);
        }

        $ky = isset($_GET['ky']) && $_GET['ky'] !== '' ? intval($_GET['ky']) : null;
        $nam = isset($_GET['nam']) && $_GET['nam'] !== '' ? intval($_GET['nam']) : null;

        $result = $client->getTienNuoc($danhba, $ky, $nam);
        handleClientResult($result);
        break;

    case 'san-luong':
        if ($method !== 'GET') {
            sendResponse(false, null, 'Method Not Allowed. Only GET requests are supported.', 405);
        }

        $danhba = isset($_GET['danhba']) ? trim($_GET['danhba']) : '';
        if (empty($danhba)) {
            sendResponse(false, null, 'Parameter "danhba" is required and cannot be empty.', 400);
        }

        $ky = isset($_GET['ky']) && $_GET['ky'] !== '' ? intval($_GET['ky']) : null;
        $nam = isset($_GET['nam']) && $_GET['nam'] !== '' ? intval($_GET['nam']) : null;

        $result = $client->getSanLuong($danhba, $ky, $nam);
        handleClientResult($result);
        break;

    case 'so-sanh-tang-giam':
        if ($method !== 'GET') {
            sendResponse(false, null, 'Method Not Allowed. Only GET requests are supported.', 405);
        }

        $danhba = isset($_GET['danhba']) ? trim($_GET['danhba']) : '';
        if (empty($danhba)) {
            sendResponse(false, null, 'Parameter "danhba" is required and cannot be empty.', 400);
        }

        $ky = isset($_GET['ky']) && $_GET['ky'] !== '' ? intval($_GET['ky']) : null;
        $nam = isset($_GET['nam']) && $_GET['nam'] !== '' ? intval($_GET['nam']) : null;

        $result = $client->getSoSanhTangGiam($danhba, $ky, $nam);
        handleClientResult($result);
        break;

    case 'cup-nuoc':
        if ($method !== 'GET') {
            sendResponse(false, null, 'Method Not Allowed. Only GET requests are supported.', 405);
        }

        $danhba = isset($_GET['danhba']) ? trim($_GET['danhba']) : '';
        if (empty($danhba)) {
            sendResponse(false, null, 'Parameter "danhba" is required and cannot be empty.', 400);
        }

        $result = $client->getThongBaoCupNuoc($danhba);
        handleClientResult($result);
        break;

    case 'thong-tin-khach-hang':
        if ($method !== 'GET') {
            sendResponse(false, null, 'Method Not Allowed. Only GET requests are supported.', 405);
        }

        $danhba = isset($_GET['danhba']) ? trim($_GET['danhba']) : null;
        $sdt = isset($_GET['sdt']) ? trim($_GET['sdt']) : null;

        if (empty($danhba) && empty($sdt)) {
            sendResponse(false, null, 'Either parameter "danhba" or "sdt" must be provided.', 400);
        }

        // $result = $client->getThongTinKhachHang(null, $sdt);
        // Wait, check the exact name of the method: getThongTinKhachHang. 
        // Let's call the correct method name 'getThongTinKhachHang'.
        // echo "\n\r so danh ba : ";
        // echo $danhba;
        // echo "\n\r so dien thoai : ";
        // echo $sdt;
        $result = $client->getThongTinKhachHang($danhba, $sdt);
        handleClientResult($result);
        break;

    case 'bao-su-co':
        if ($method !== 'POST') {
            sendResponse(false, null, 'Method Not Allowed. Only POST requests are supported.', 405);
        }

        // Try reading JSON input body first, then fallback to $_POST
        $inputJSON = file_get_contents('php://input');
        $input = json_decode($inputJSON, true);
        if (!is_array($input)) {
            $input = $_POST;
        }

        $danhba = isset($input['danhba']) ? trim($input['danhba']) : '';
        $noidung = isset($input['noidung']) ? trim($input['noidung']) : '';
        // [cập nhật 07/08/2026] danhba KHÔNG còn bắt buộc — hỗ trợ lời nhắn
        // không gắn mã danh bộ (vd khách gọi chỉ để nhờ liên hệ lại, chưa xác
        // minh tài khoản). Thêm "tel" để backend biết SĐT liên hệ khi thiếu
        // danhba. LƯU Ý: file này là bản THAM KHẢO trong repo Node — cần đối
        // chiếu lại với gateway PHP thật đang chạy trên server để đảm bảo khớp
        // (Node gọi qua TONGDAI_API_BASE, không chạy trực tiếp file này).
        $tel = isset($input['tel']) ? trim($input['tel']) : '';

        if (empty($noidung)) {
            sendResponse(false, null, 'Parameter "noidung" is required in the POST body.', 400);
        }

        $result = $client->baoSuCo($danhba, $noidung, $tel);
        handleClientResult($result);
        break;

    default:
        sendResponse(false, null, 'Resource Not Found. Endpoint "/' . $path . '" does not exist.', 404);
        break;
}

/**
 * Handle API Client result array and output standard format
 * @param array $result
 */
function handleClientResult(array $result)
{
    if ($result['ok']) {
        // Return matching upstream HTTP status code or fallback to 200
        $code = ($result['http_code'] >= 200 && $result['http_code'] < 300) ? 200 : $result['http_code'];
        sendResponse(true, $result['json'] !== null ? $result['json'] : $result['raw'], null, $code);
    } else {
        // If there was a connection error or non-success code
        $code = $result['http_code'] > 0 ? $result['http_code'] : 500;
        $errorMsg = $result['error'] !== null ? $result['error'] : 'Upstream service returned an error status code.';
        sendResponse(false, $result['json'] !== null ? $result['json'] : $result['raw'], $errorMsg, $code);
    }
}
