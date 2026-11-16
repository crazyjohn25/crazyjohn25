import Boot from "./boot";

export default function Page() {
  return (
    <>
      <header className="top">
        <div>
          <p className="brand">核对台</p>
          <p className="tag">把技术结构、已排期的宏观事件和标的新闻放在一起核对。分数解释结构，不承诺收益。</p>
        </div>
        <p id="clock" className="clock">正在连接公开行情</p>
      </header>
      <div className="layout">
        <aside id="rail" aria-label="标的" />
        <main id="main">
          <p className="loading">正在读取行情、日程和新闻。</p>
        </main>
      </div>
      <Boot />
    </>
  );
}
