import "../marketdesk/static/styles.css";

export const metadata = {
  title: "核对台",
  description: "把技术结构、已排期的宏观事件和标的新闻放在一起核对。分数解释结构，不承诺收益。",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
