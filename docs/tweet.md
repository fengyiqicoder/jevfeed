# Launch tweet

## Main tweet (attach docs/media/demo.mp4)

I built a feed with no likes, no follows and no accounts.

It reads my own browser history, pulls the links out of the pages I already read,
and hands all of them to a decision model at once. It returns a probability over
every candidate. The top ten become the next batch. ~500ms.

The only thing it learns from is how long I linger and what I open.

github.com/fengyiqicoder/jevfeed

## Reply 1

Why links and not generated text: a generated feed optimized on dwell time
converges on a mirror of your own habits, and nothing in it has a source you can
check. Every item here was put in a real page by a real person, with a URL.

## Reply 2

How a batch is built:

history → links in the page body (via Jina Reader) → one sentence + a page kind
from a cheap model, which drops tools, shopping pages and listings → all
remaining candidates to Jev in one request → top 10.

Runs locally. History never leaves the machine.

## Reply 3

The detail that surprised me: crediting dwell time to every post on screen is
useless. Five cards fit at once, so they all get the same number. Dwell only
means something when it goes to the one post nearest the middle of the screen.

MIT licensed, Node 22, bring your own keys.

---

# 中文版

我做了一个没有点赞、没有关注、没有账号的信息流。

它读我自己的浏览器历史，把我已经读过的那些页面正文里的链接抽出来，一次性全交给决策模型。
它返回对每个候选的概率，前十条进入下一批，大约 500 毫秒。

它唯一学习的东西，是我在哪条上停留、点开了什么。

github.com/fengyiqicoder/jevfeed
