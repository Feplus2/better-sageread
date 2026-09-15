// assign a unique ID for each TOC item
const assignIDs = toc => {
    let id = 0
    const assignID = item => {
        item.id = id++
        if (item.subitems) for (const subitem of item.subitems) assignID(subitem)
    }
    for (const item of toc) assignID(item)
    return toc
}

const flatten = items => items
    .map(item => item.subitems?.length
        ? [item, flatten(item.subitems)].flat()
        : item)
    .flat()

export class TOCProgress {
    async init({ toc, ids, splitHref, getFragment }) {
        assignIDs(toc)
        const items = flatten(toc)
        const grouped = new Map()
        for (const [i, item] of items.entries()) {
            const [id, fragment] = await splitHref(item?.href) ?? []
            const value = { fragment, item }
            if (grouped.has(id)) grouped.get(id).items.push(value)
            else grouped.set(id, { prev: items[i - 1], items: [value] })
        }
        const map = new Map()
        for (const [i, id] of ids.entries()) {
            if (grouped.has(id)) map.set(id, grouped.get(id))
            else map.set(id, map.get(ids[i - 1]))
        }
        this.ids = ids
        this.map = map
        this.getFragment = getFragment
    }
    getProgress(index, range) {
        if (!this.ids) return
        const id = this.ids[index]
        const obj = this.map.get(id)
        if (!obj) return null
        const { prev, items } = obj
        if (!items) return prev
        if (!range || items.length === 1 && !items[0].fragment) return items[0].item

        const doc = range.startContainer.getRootNode()
        // 当前小节的判定锚定视口【顶部】而非底部：用折叠到 range 起点的位置比较锚点。
        // 原实现按"最后一个不晚于 range 末尾的锚点"判定——未加载完的内容（图片 0 高
        // 塌陷等）会让 range 末尾越过整个章末，把所有锚点都判成"已过"，位置反复
        // 掉到本章最后一项（实测滚动中 5.x→5.9 鬼影交替）。
        // 顶部判定对该类布局塌陷免疫，且与 CFI/阅读进度保存的顶部语义一致。
        const start = range.cloneRange()
        start.collapse(true)
        // 记录"锚点解析成功且不晚于视口顶部"的最近条目：循环正常跑完时返回它，
        // 而不是无条件返回组内最后一项——锚点缺失（错配/转换产物坏 id）时
        // 原逻辑会把位置误判成章末
        let lastResolved = null
        for (const [i, { fragment }] of items.entries()) {
            const el = this.getFragment(doc, fragment)
            if (!el) continue
            if (start.comparePoint(el, 0) > 0)
                return lastResolved ?? (items[i - 1]?.item ?? prev)
            lastResolved = items[i].item
        }
        // 一个锚点都没解析出来（异常情况）时退回本章首项，而不是章末
        return lastResolved ?? items[0].item
    }
}

export class SectionProgress {
    constructor(sections, sizePerLoc, sizePerTimeUnit) {
        this.sizes = sections.map(s => s.linear != 'no' && s.size > 0 ? s.size : 0)
        this.sizePerLoc = sizePerLoc
        this.sizePerTimeUnit = sizePerTimeUnit
        this.sizeTotal = this.sizes.reduce((a, b) => a + b, 0)
        this.sectionFractions = this.#getSectionFractions()
    }
    #getSectionFractions() {
        const { sizeTotal } = this
        const results = [0]
        let sum = 0
        for (const size of this.sizes) results.push((sum += size) / sizeTotal)
        return results
    }
    // get progress given index of and fractions within a section
    getProgress(index, fractionInSection, pageFraction = 0) {
        const { sizes, sizePerLoc, sizePerTimeUnit, sizeTotal } = this
        const sizeInSection = sizes[index] ?? 0
        const sizeBefore = sizes.slice(0, index).reduce((a, b) => a + b, 0)
        const size = sizeBefore + fractionInSection * sizeInSection
        const nextSize = size + pageFraction * sizeInSection
        const remainingTotal = sizeTotal - size
        const remainingSection = (1 - fractionInSection) * sizeInSection
        return {
            fraction: nextSize / sizeTotal,
            section: {
                current: index,
                total: sizes.length,
            },
            location: {
                current: Math.floor(size / sizePerLoc),
                next: Math.floor(nextSize / sizePerLoc),
                total: Math.ceil(sizeTotal / sizePerLoc),
            },
            time: {
                section: remainingSection / sizePerTimeUnit,
                total: remainingTotal / sizePerTimeUnit,
            },
        }
    }
    // the inverse of `getProgress`
    // get index of and fraction in section based on total fraction
    getSection(fraction) {
        if (fraction <= 0) return [0, 0]
        if (fraction >= 1) return [this.sizes.length - 1, 1]
        fraction = fraction + Number.EPSILON
        const { sizeTotal } = this
        let index = this.sectionFractions.findIndex(x => x > fraction) - 1
        if (index < 0) return [0, 0]
        while (!this.sizes[index]) index++
        const fractionInSection = (fraction - this.sectionFractions[index])
            / (this.sizes[index] / sizeTotal)
        return [index, fractionInSection]
    }
}
