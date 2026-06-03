##TEST: 2. Tra cứu sản lượng
### Không có sản lượng
Request: GET http://127.0.0.1:7700/api.php/san-luong?danhba=15122890724&ky=4&nam=2026
HTTP Status Code: 200
{
"success": true,
"http_code": 200,
"data": {
"success": false,
"error_code": "PRODUCTION_NOT_FOUND",
"message": "Chưa có sản lượng kỳ này.",
"data": null
}
}
### Có sản lượng
Request: GET http://127.0.0.1:7700/api.php/san-luong?danhba=15122890724&ky=3&nam=2025
HTTP Status Code: 200
{
"success": true,
"http_code": 200,
"data": {
"success": true,
"message": "Lấy thông tin sản lượng thành công.",
"data": [
{
"Nam": 2025,
"Ky": 3,
"TongTien": 223687,
"SanLuong": 16
}
]
}
}

### Lỗi không có số danh bộ
Request: GET http://127.0.0.1:7700/api.php/san-luong?danhba=151228907241&ky=3&nam=2025
HTTP Status Code: 200
{
"success": true,
"http_code": 200,
"data": {
"success": false,
"error_code": "CUSTOMER_NOT_FOUND",
"message": "Không tìm thấy thông tin khách hàng.",
"data": null
}
}

## TEST: 4. Thông báo cúp nước
### Không có sự cố
Request: GET http://127.0.0.1:7700/api.php/cup-nuoc?danhba=15052170779
HTTP Status Code: 200
{
    "success": true,
    "http_code": 200,
    "data": {
        "success": true,
        "message": "Lấy thông tin cúp nước thành công.",
        "data": {
            "coSuCo": false,
            "thongBao": "Khách hàng không nằm trong vùng bị sự cố.",
            "thoiGianDuKienHoanThanh": ""
        }
    }
}

{
    "success": true,
    "message": "Lấy thông tin cúp nước thành công.",
    "data": {
        "coSuCo": true,
        "thongBao": "Khách hàng nằm trong vùng bị sự cố.",
        "thoiGianDuKienHoanThanh": "22/05/2026 16:00"
    }
}

## TEST: 5b. GetThongTinKhachHang theo so dien thoai
### Có thông tin 
TEST: 5. Thông tin khách hàng
Request: GET http://127.0.0.1:7700/api.php/thong-tin-khach-hang?sdt=0908486326
HTTP Status Code: 200
{
    "success": true,
    "http_code": 200,
    "data": {
        "success": true,
        "message": "Lấy thông tin khách hàng thành công.",
        "data": [
            {
                "danhBa": "15122890724",
                "hoTen": "TRAN VAN DU"
            },
            {
                "danhBa": "22103413649",
                "hoTen": "TRAN VAN DU"
            }
        ]
    }
}

### theo danh bạ, có thông tin
Request: GET http://127.0.0.1:7700/api.php/thong-tin-khach-hang?danhba=15122890724
HTTP Status Code: 200
{
    "success": true,
    "http_code": 200,
    "data": {
        "success": true,
        "message": "Lấy thông tin khách hàng thành công.",
        "data": [
            {
                "danhBa": "15122890724",
                "hoTen": "TRAN VAN DU"
            }
        ]
    }
}

#### Không có thông tin
Request: GET http://127.0.0.1:7700/api.php/thong-tin-khach-hang?sdt=09084863261
HTTP Status Code: 200
{
    "success": true,
    "http_code": 200,
    "data": {
        "success": false,
        "error_code": "CUSTOMER_NOT_FOUND",
        "message": "Không tìm thấy thông tin khách hàng.",
        "data": null
    }
}


TEST: 5. Thông tin khách hàng theo danh ba
Request: GET http://127.0.0.1:7700/api.php/thong-tin-khach-hang?danhba=151228907241
HTTP Status Code: 200
{
    "success": true,
    "http_code": 200,
    "data": {
        "success": false,
        "error_code": "CUSTOMER_NOT_FOUND",
        "message": "Không tìm thấy thông tin khách hàng.",
        "data": null
    }
}