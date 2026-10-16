# Radar Futures

Web app phân tích lệnh Futures (USDT-M, Binance) chạy trên máy của bạn.

## Chạy

```bash
cd radar-futures
python3 server.py
```

Mở http://127.0.0.1:8765. Trên macOS có thể nhấp đúp `start.command`.
Không cần cài thêm gì (chỉ dùng Python 3 có sẵn). Cần internet để lấy giá và tin tức.

## Bản online: https://vuhuykhanh.github.io/future/

App được đăng trên GitHub Pages (miễn phí, chạy 24/7, có HTTPS), không cần máy tính nào bật.

- Mở link trên điện thoại, rồi trong Safari bấm **Chia sẻ → Thêm vào MH chính** để dùng như một app.
  Trên Android (Chrome): menu ⋮ → **Thêm vào màn hình chính / Cài đặt ứng dụng**.
  Mở trong trình duyệt: 3 tab nằm dưới tiêu đề. Mở từ màn hình chính: thanh điều hướng ở đáy và nút "Đã vào lệnh" nổi.
  Giao diện tự xuống dòng khi điện thoại đặt cỡ chữ lớn, không tràn ngang.
- Giá, phân tích, kiểm tra lịch sử chạy ngay trên điện thoại (gọi thẳng Binance).
- Tin tức và lịch FOMC/CPI/PPI do GitHub Actions lấy lại mỗi 30 phút (`.github/workflows/pages.yml` chạy `tools/build_feeds.py`).
- **Nhật ký lệnh lưu ngay trên điện thoại**, không đưa lên GitHub. Xóa dữ liệu Safari hoặc gỡ app khỏi màn hình chính là mất,
  nên thỉnh thoảng vào tab Thống kê bấm **Xuất JSON** để sao lưu. Nhật ký trên bản online và trên server ở máy tính là hai nơi khác nhau.
- Mỗi lần đẩy code lên nhánh `main`, trang tự cập nhật sau khoảng 1 phút.
- GitHub tự tắt lịch chạy 30 phút nếu repo không có thay đổi nào trong 60 ngày. Khi đó tin tức sẽ cũ dần;
  vào tab **Actions** của repo bấm bật lại, hoặc chạy tay "Deploy Radar Futures".

## Dùng trên điện thoại qua máy tính (cùng Wi‑Fi)

1. Chạy server trên máy Mac như trên. Điện thoại phải dùng **cùng mạng Wi‑Fi** với máy Mac.
2. Trên máy Mac, mở app và bấm **nút hình điện thoại** ở góc trên bên phải, rồi quét mã QR bằng camera điện thoại.
   Cũng có thể mở đường link `http://<IP-máy-Mac>:8765/?key=...` mà server in ra khi khởi động.
3. Trong Safari bấm **Chia sẻ → Thêm vào MH chính** để mở như một app (toàn màn hình, có biểu tượng riêng).

- Đường link chứa **mã khóa riêng** (lưu ở `data/access_key`). Không có mã thì máy khác trong mạng không đọc/sửa được nhật ký lệnh.
  Đừng chia sẻ link này. Muốn đổi mã: xóa file `data/access_key` rồi khởi động lại server.
- Nhật ký lệnh dùng chung giữa máy Mac và điện thoại. Vào lệnh trên điện thoại thì máy Mac cũng thấy, và ngược lại.
- Lần đầu chạy, macOS có thể hỏi có cho Python nhận kết nối từ mạng không: chọn **Cho phép**.
- Ra khỏi nhà (khác Wi‑Fi) thì điện thoại không vào được, vì app chạy trên máy Mac của bạn.
- Chỉ muốn dùng trên máy Mac: chạy `HOST=127.0.0.1 python3 server.py`.

Nút sáng/tối ở góc trên chuyển vòng: **tự động theo máy → sáng → tối**.

## Trang Phân tích

Nhập coin, đòn bẩy, số tiền vào lệnh, phong cách (Scalp 15m / Intraday 1h / Swing 4h), hướng (Tự động / Long / Short).

Kết quả chỉ gồm thông tin cần để quyết định vào lệnh:
- **Kết luận**: Có thể vào / Đặt lệnh chờ / Chờ xác nhận / Không nên vào, kèm lý do ngắn.
- **Tỷ lệ thắng trong quá khứ**: xem mục bên dưới.
- **Kỳ vọng mỗi lệnh**: lãi/lỗ trung bình của các tín hiệu tương tự trong quá khứ, đã tính phí và các lệnh hết giờ.
- **Kế hoạch lệnh**: Entry, Stop Loss, TP1, TP2, giá thanh lý.
- **Tiền & lợi nhuận**: lãi tại TP1, lãi theo kế hoạch 50/50, lỗ nếu chạm SL (không vượt quá số tiền ký quỹ), đòn bẩy an toàn tối đa.
- **Khi nào bán** và **rủi ro** chính.

Phía sau, app vẫn phân tích đủ 13 yếu tố (EMA 2 khung, MACD, RSI, Bollinger, dòng lệnh taker, Open Interest, funding,
tỷ lệ Long/Short, xu hướng BTC, Fear & Greed + vốn hóa, tin tức coin và toàn thị trường) để ra kết luận, nhưng không hiển thị chi tiết.

### Tỷ lệ thắng: chọn chiến lược trên dữ liệu cũ, kiểm tra trên dữ liệu mới

Mỗi lần phân tích, app tải 1.500 nến gần nhất của chính coin và khung đó (khoảng 15 ngày với 15m, 2 tháng với 1h, 8 tháng với 4h),
chạy lại bộ phân tích ở từng thời điểm trong quá khứ và mô phỏng 6 chiến lược (`public/js/strategies.js`):

| Chiến lược | Chốt lời | Cần thắng để hòa vốn |
|---|---|---|
| Theo xu hướng | 1,5R | 40% |
| Theo xu hướng, chốt sớm | 1R | 50% |
| Theo xu hướng, chốt xa | 2R | 33% |
| Theo xu hướng, chỉ vào khi giá hồi về EMA20 | 1,5R | 40% |
| Đánh ngược khi quá mua/quá bán (RSI cực đoan + ngoài dải Bollinger) | 1,5R | 40% |
| Theo xu hướng khi BTC cùng hướng và ADX ≥ 20 | 1,5R | 40% |

(R = khoảng cách từ giá vào tới Stop Loss. Phí giao dịch và lệnh hết thời gian giữ đều được tính.)

1. **Chọn** chiến lược có kỳ vọng tốt nhất trên **60% dữ liệu cũ**, trong số những chiến lược đang có tín hiệu lúc này.
2. **Kiểm tra** đúng chiến lược đó trên **40% dữ liệu mới** (cách phần cũ một khoảng bằng thời gian giữ lệnh). Phần này không được dùng để chọn.
3. Con số hiển thị là tỷ lệ chạm TP1 trước SL trên phần dữ liệu mới. Mẫu nhỏ được kéo về mức hòa vốn để tránh con số ảo.
4. App chỉ khuyên vào lệnh khi tỷ lệ đó **vượt mức hòa vốn của chiến lược** và **kỳ vọng dương**, không có rủi ro nghiêm trọng (ví dụ giá thanh lý trước SL).

Lý do tách hai phần: thử 6 chiến lược rồi báo luôn kết quả của cái tốt nhất trên cùng dữ liệu sẽ cho con số đẹp ảo nhờ may mắn.
Màn hình chỉ hiện chiến lược tốt nhất được chọn.

Funding, Open Interest, tỷ lệ Long/Short, tâm lý và tin tức không có dữ liệu quá khứ đủ dài, nên phần kiểm tra chỉ dùng các yếu tố giá;
các yếu tố kia vẫn dùng để cảnh báo rủi ro. Quá khứ không đảm bảo tương lai.

### Fed và vĩ mô

- **Tin Fed/vĩ mô** được chấm riêng: thắt chặt (tăng lãi suất, lạm phát nóng, "higher for longer", lợi suất tăng) là xấu cho crypto,
  nới lỏng (cắt giảm lãi suất, lạm phát hạ nhiệt, lợi suất giảm) là tốt. App hiểu cả câu phủ định như "avoids rate-hike hints".
  Nếu dòng tin vĩ mô 48 giờ qua ngược hướng lệnh, mục Rủi ro hiện tiêu đề tin đó.
- **Lịch sự kiện:** giờ Fed công bố lãi suất (FOMC) lấy từ federalreserve.gov; giờ công bố CPI và PPI lấy từ lịch của Fed St. Louis (ALFRED).
  Trang của BLS chặn truy cập tự động nên không dùng được.
  Mục Rủi ro cảnh báo khi sự kiện sắp diễn ra trong 2 giờ, vừa diễn ra trong 1 giờ, hoặc rơi vào thời gian giữ lệnh.

### Giá real-time

Giá live qua WebSocket Binance Futures (khoảng 4 lần/giây), khoảng cách tới SL/TP1, đồng hồ đếm ngược tới lúc đóng nến.
App cảnh báo khi kế hoạch không còn đúng (giá lệch khỏi entry, đã tới TP1 hoặc đã chạm SL) và tự phân tích lại mỗi khi đóng nến (bật/tắt được).

## Vào lệnh và đóng lệnh

1. Đặt lệnh trên sàn, rồi bấm **Đã vào lệnh** và nhập giá vào thực tế, số tiền, đòn bẩy. Chỉ lúc này lệnh mới được ghi vào lịch sử.
2. Lệnh xuất hiện ở mục **Lệnh đang mở** (đầu trang Phân tích) với giá và lãi/lỗ live. Khi giá chạm TP1, TP2, SL hoặc giá thanh lý, app hiện nhắc nhở,
   nhưng **không tự đóng lệnh**.
3. Khi đã thoát trên sàn, bấm **Đóng lệnh** và nhập giá đóng (giá trung bình nếu bạn chốt nhiều lần). Lúc này lệnh mới kết thúc và được tính vào thống kê.

## Trang Gợi ý

Quét 50 coin có khối lượng giao dịch 24h lớn nhất trên Binance Futures (chỉ hợp đồng crypto; bỏ stablecoin, vàng token hóa,
chỉ số và cổ phiếu), chọn và kiểm tra chiến lược cho từng coin như trên, rồi đưa ra **2 coin có tỷ lệ thắng vượt mức hòa vốn nhiều nhất**
(xếp theo mức vượt chứ không theo tỷ lệ thô, vì chiến lược chốt 1R tự nhiên có tỷ lệ cao hơn chiến lược chốt 2R).
Coin đạt điều kiện được ưu tiên; nếu chưa đủ 2 coin đạt, chỗ còn lại là coin gần nhất và ghi rõ "Bỏ qua".

- Khoảng 15 giây. App tự giới hạn tốc độ gọi Binance (dưới 1.600/2.400 điểm mỗi phút) để không bị chặn,
  và giữ màn hình sáng trong lúc quét nếu điện thoại cho phép. Có thể dừng giữa chừng.
- Dùng đòn bẩy và số tiền đang nhập ở trang Phân tích (ảnh hưởng tới cảnh báo thanh lý).
- "Đạt điều kiện" = kết luận "Có thể vào" hoặc "Đặt lệnh chờ", giống hệt trang Phân tích. Coin tỷ lệ cao nhưng bị loại có ghi lý do.
- Kết quả được lưu lại và dùng được tới khi nến của khung đó đóng; sau đó app báo đã cũ để quét lại.
- Bấm vào coin để mở phân tích chi tiết.

## Trang Thống kê

- Tỷ lệ thắng, lãi/lỗ, profit factor, R trung bình, chuỗi thua, đường vốn, hiệu quả theo hướng/phong cách/đòn bẩy/coin.
- **Dự đoán có chính xác không?**: so xác suất dự đoán với tỷ lệ thắng thực tế. Nhóm có từ 3 lệnh sẽ được dùng để hiệu chỉnh các lần sau.
- Có thể đóng hoặc xóa lệnh ngay trong bảng nhật ký.

### Tự học khi thua

Kích hoạt khi **thua 3 lệnh liên tiếp** hoặc **thua 3 trong 5 lệnh gần nhất**:
1. Tìm điều kiện chung của các lệnh thua (ngược BTC, đòn bẩy > 15x, ADX < 20, ngược tin tức, vào đuổi, một hướng hoặc phong cách cụ thể…)
   và thêm quy tắc chặn/cảnh báo tương ứng.
2. Giảm trọng số các yếu tố hay "đồng thuận" với lệnh thua, tăng trọng số yếu tố đáng tin.
3. Tăng ngưỡng tín hiệu tối thiểu thêm 5 điểm (tối đa 45).
4. Bật chế độ phòng thủ (khuyên giảm 50% đòn bẩy và vốn). Tự tắt sau 2 lệnh thắng liên tiếp.

Dữ liệu lưu ở `data/state.json`. Có nút Xuất/Nhập JSON để sao lưu.

## Lưu ý

Đây là công cụ tham khảo, không phải lời khuyên đầu tư. Xác suất là ước tính heuristic. Không có phân tích nào đảm bảo thắng,
và lệnh đòn bẩy có thể mất toàn bộ số tiền vào lệnh. Hãy theo dõi trang Thống kê ít nhất 20–30 lệnh trước khi tin vào con số.
