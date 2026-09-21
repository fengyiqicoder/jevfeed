# Launch tweet

Attach `docs/media/demo.mp4` to the main tweet. Post the three replies as a thread underneath.

## Main tweet

No likes, no follows, no accounts, no buttons. So what does it run on? JevFeed is an infinite feed from your browser history: 200 recent pages seed it, their links are candidates, how you scroll and what you open is the only feedback. github.com/fengyiqicoder/jevfeed

## Replies

Seconds on screen is not attention: credit every visible card and they all tie. So dwell goes every 200 ms to the one card nearest screen centre. Scrolling past logs its exit px/s; opening logs your read time. The last 150 events go straight into the next request.

Ranking is one request to Jev, TypeSafe's hosted model, with your own API key: up to ~250 unseen links go in and a probability over all of them comes back. The top 10 land in the feed, max 3 per domain. In the demo that was 66 links ranked in 464 ms.

What leaves the machine: not the History file. Seed pages, pages you open and every candidate get fetched, via Jina when needed; candidate URLs also go to OpenRouter for summaries. Jev gets titles (40 from history), domains, kinds, summaries and scroll numbers, never a URL.

---

# 中文版

## 主推

没有点赞、没有关注、没有账号、没有按钮。那它靠什么运转？JevFeed 是拿你自己的浏览器历史做出来的无限信息流：最近访问的 200 个页面是种子，正文里的链接是候选，你怎么滚动、点开什么，是唯一的反馈。github.com/fengyiqicoder/jevfeed

## 回复

一张卡在屏幕上待了几秒，不代表你在看它：给屏幕上每张卡都记时间，它们拿到的数字一模一样。所以每 200 ms 只给离屏幕中线最近的那一张记停留时间；卡片从顶部滚出时，记下那一刻的滚动速度（px/s）；点开后切回来，算你读了几秒。最近 150 条事件直接进下一次请求。

排序只发一次请求：最多约 250 条没看过的链接一起发给 Jev（TypeSafe 的托管模型，要用你自己的 key），它返回覆盖全部候选的概率分布，取前 10 条，每个域名最多 3 条。Demo 里 66 条排完用了 464 ms。

哪些数据会离开你的电脑：History 文件本身不上传。200 个种子页、你点开的页面、每条候选都会被抓取（必要时经 Jina），候选页 URL 还会发给 OpenRouter 做摘要。Jev 拿到的是标题（含 40 条历史标题）、域名、类型、摘要和滚动数据，没有 URL。
