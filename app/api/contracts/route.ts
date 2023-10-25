/*
 * @Author: beau beau.js@outlook.com
 * @Date: 2023-10-17 13:48:20
 * @LastEditors: beau beau.js@outlook.com
 * @LastEditTime: 2023-10-26 02:59:34
 * @FilePath: /workspace/contract-monitor/app/api/contracts/route.ts
 * @Description:
 *
 * Copyright (c) 2023 by ${git_name_email}, All Rights Reserved.
 */
/*
 * @Author: beau beau.js@outlook.com
 * @Date: 2023-10-17 13:48:20
 * @LastEditors: beau beau.js@outlook.com
 * @LastEditTime: 2023-10-21 21:30:00
 * @FilePath: /workspace/contract-monitor-dev/app/api/contracts/route.ts
 * @Description:
 *
 * Copyright (c) 2023 by ${git_name_email}, All Rights Reserved.
 */
import prisma from "@/prisma/db";
import { NextResponse } from "next/server";

// POST
export async function POST(request: Request) {
  // 验证post是否合法
  const data = await request.json();
  if (data.name !== "beau" || data.pwd !== process.env.BEAU_PWD)
    return NextResponse.json({ msg: "Invalid Token" });

  interface BinanceMarkPriceData {
    symbol: string;
    markPrice: string;
    lastFundingRate: string;
  }

  interface BinanceOpenInterestData {
    symbol: string;
    sumOpenInterest: string;
    sumOpenInterestValue: string;
    timestamp: number;
  }

  type HighGrowthTokenData = BinanceMarkPriceData &
    BinanceOpenInterestData & {
      timestamp: string; // 将timestamp的类型从number改为string
      contractPositionGrowth: string;
    };

  interface PostLarkData {
    msg_type: string;
    content: {
      text: string;
    };
  }

  // 封装 fetch lark机器人
  const postLarkHandler = async (data: PostLarkData) => {
    const RES = await fetch(process.env.LARK_HOOK_URL as string, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!RES.ok) return "Post Data to Lark Failed";

    const DATA = await RES.json();
    return DATA;
  };

  // 封装fetch symbol和资金费率
  const fetchBinanceMarkPriceInfo = async (): Promise<
    BinanceMarkPriceData[] | BinanceMarkPriceData | string
  > => {
    const RES = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex`, {
      next: { revalidate: 10 },
    });

    if (!RES.ok) return "Fetch Binance Mark Price Failed";

    const DATA = await RES.json();
    if (DATA.length === 0 || DATA.msg) return `Invalid symbol`;

    return DATA;
  };

  // 封装fetch 合约持仓量数据函数
  const fetchBinanceOpenInterestStatistics = async (
    symbol: string
  ): Promise<BinanceOpenInterestData[] | string> => {
    const RES = await fetch(
      `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=289`,
      {
        next: { revalidate: 10 },
      }
    );

    if (!RES.ok) return `Fetch Binance Open Interest Statistics Failed`;

    const data = await RES.json();

    if (Array.isArray(data) && data.length === 0) return `Not Found the symbol`;

    if (!Array.isArray(data)) return `Symbol Is Necessary`;

    return data;
  };

  // 将时间戳转换成UTC+8时间
  const convertTZ = (timestamp: number, tzString: string) => {
    // 将timestamp转换成Date对象，并乘以1000，因为JavaScript的时间戳是毫秒为单位
    const date = new Date(timestamp);
    // 使用toLocaleString方法，指定时区为tzString，并返回结果
    return date.toLocaleString("zh-CN", { timeZone: tzString });
  };

  const MARK_PRICE_INFO = (await fetchBinanceMarkPriceInfo()) as string | BinanceMarkPriceData[];

  if (typeof MARK_PRICE_INFO === "string")
    return NextResponse.json({ msg: MARK_PRICE_INFO }, { status: 400 });

  // 筛选合约持仓增长量达标的币对
  const HIGH_GROWTH_TOKEN = (
    await Promise.all(
      MARK_PRICE_INFO.map(async ({ symbol, markPrice, lastFundingRate }) => {
        const OPEN_INTEREST_DATA = await fetchBinanceOpenInterestStatistics(symbol);

        if (typeof OPEN_INTEREST_DATA === "string") return null;

        const OLDEST_OPEN_INTEREST_STATISTICS = OPEN_INTEREST_DATA[0];

        const LATEST_OPEN_INTEREST_STATISTICS = OPEN_INTEREST_DATA[OPEN_INTEREST_DATA.length - 1];

        const OPEN_INTEREST_POSITION_GROWTH_RATE =
          (Number(LATEST_OPEN_INTEREST_STATISTICS.sumOpenInterestValue) -
            Number(OLDEST_OPEN_INTEREST_STATISTICS.sumOpenInterestValue)) /
          Number(OLDEST_OPEN_INTEREST_STATISTICS.sumOpenInterestValue);

        if (OPEN_INTEREST_POSITION_GROWTH_RATE < 0.4) return null;

        return {
          symbol,
          markPrice: Number(markPrice).toFixed(4),
          lastFundingRate: (Number(lastFundingRate) * 100).toFixed(4) + "%",
          contractPositionGrowth:
            (Number(OPEN_INTEREST_POSITION_GROWTH_RATE) * 100).toFixed(2) + "%",
          sumOpenInterest: Number(LATEST_OPEN_INTEREST_STATISTICS.sumOpenInterest).toFixed(4),
          sumOpenInterestValue: Number(
            LATEST_OPEN_INTEREST_STATISTICS.sumOpenInterestValue
          ).toFixed(2),
          timestamp: convertTZ(LATEST_OPEN_INTEREST_STATISTICS.timestamp, "Asia/Shanghai"),
        };
      })
    )
  ).filter(Boolean) as HighGrowthTokenData[] | [];

  // 处理没有合约持仓增长量达标的情况
  if (HIGH_GROWTH_TOKEN.length === 0)
    return NextResponse.json(
      { msg: `No Pairs Meet The Contract Position Growth Rate Condition` },
      { status: 204 }
    );

  await prisma.hightGrowthToken.deleteMany();

  await prisma.hightGrowthToken.createMany({
    data: HIGH_GROWTH_TOKEN,
  });

  // 转换成易读的格式
  const LARK_DATA = HIGH_GROWTH_TOKEN.map(
    ({
      symbol,
      markPrice,
      lastFundingRate,
      contractPositionGrowth,
      sumOpenInterestValue,
      timestamp,
    }) => {
      return `
        交易币对：${symbol}
        标记价格：${markPrice}
        资金费率: ${lastFundingRate}
        24H合约持仓增长量: ${contractPositionGrowth}
        合约持仓价值: ${sumOpenInterestValue}
        更新时间：${timestamp}
        `;
    }
  );
  // 向lark机器人post数据
  const POST_LARK_DATA = {
    msg_type: "text",
    content: {
      text: `行情警报:
          ${JSON.parse(JSON.stringify(LARK_DATA)).join("")}`,
    },
  };
  const DATA = await postLarkHandler(POST_LARK_DATA);

  return NextResponse.json(DATA);
}
