import { world, system } from "@minecraft/server"

const BREAKER_ID = "sb:shield_breaker"
const DEFAULT_LENGTH = 100
const SLICES_PER_TICK = 10        // 1tickに掘る奥行き
const DROP_ITEMS = false          // trueで壊したブロックがドロップ(重くなる)

// ブロックごとの掘る長さ(マス)
const BREAKER_LENGTHS = {
    "sb:shield_breaker_30": 30,
    "sb:shield_breaker_50": 50,
    "sb:shield_breaker_100": 100
}

// 壊していいブロック。鉱石は入れていないので無視される
const BREAKABLE_BLOCKS = [
    "minecraft:stone", "minecraft:cobblestone", "minecraft:mossy_cobblestone",
    "minecraft:deepslate", "minecraft:cobbled_deepslate",
    "minecraft:andesite", "minecraft:diorite", "minecraft:granite",
    "minecraft:tuff", "minecraft:calcite", "minecraft:dripstone_block",
    "minecraft:basalt", "minecraft:smooth_basalt", "minecraft:blackstone",
    "minecraft:netherrack", "minecraft:end_stone",
    "minecraft:sandstone", "minecraft:red_sandstone", "minecraft:terracotta",
    "minecraft:dirt", "minecraft:coarse_dirt", "minecraft:grass_block",
    "minecraft:gravel", "minecraft:sand", "minecraft:clay", "minecraft:mud"
]

// クリックした面の「奥」方向(掘る方向)。North面を押すと南(+z)へ進む
const DIG_DIRECTION = {
    North: { x: 0, y: 0, z: 1 },
    South: { x: 0, y: 0, z: -1 },
    West: { x: 1, y: 0, z: 0 },
    East: { x: -1, y: 0, z: 0 },
    Up: { x: 0, y: -1, z: 0 },
    Down: { x: 0, y: 1, z: 0 }
}

function isBreaker(typeId) {
    return typeof typeId === "string" && typeId.startsWith("sb:shield_breaker_")
}

// ---- 着火: ブロックを消してエンティティを出し、掘る情報をタグに持たせる ----
function ignite(dimension, loc, typeId, dir) {
    const o = { x: loc.x, y: loc.y, z: loc.z }
    const length = BREAKER_LENGTHS[typeId] ?? DEFAULT_LENGTH
    const d = dir ?? { x: 0, y: 0, z: -1 }
    const block = dimension.getBlock(o)
    if (block) block.setType("minecraft:air")
    const entity = dimension.spawnEntity(BREAKER_ID, { x: o.x + 0.5, y: o.y, z: o.z + 0.5 })
    entity.addTag(`sb_o:${o.x}:${o.y}:${o.z}`)
    entity.addTag(`sb_d:${d.x}:${d.y}:${d.z}`)
    entity.addTag(`sb_l:${length}`)
    dimension.playSound("random.fuse", { x: o.x + 0.5, y: o.y, z: o.z + 0.5 })
}

// ---- フリント・火打ち石 / 火の玉で着火 ----
world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const { itemStack, block, player } = event
    if (!event.isFirstEvent) return
    if (!itemStack || !block || !isBreaker(block.typeId)) return
    if (itemStack.typeId !== "minecraft:flint_and_steel" && itemStack.typeId !== "minecraft:fire_charge") return

    event.cancel = true

    const dimension = player.dimension
    const loc = block.location
    const typeId = block.typeId
    const dir = DIG_DIRECTION[event.blockFace]
    const itemId = itemStack.typeId

    system.run(() => {
        try {
            ignite(dimension, loc, typeId, dir)
            consumeItem(player, itemId)
        } catch (e) {
            console.warn(`[ShieldBreaker] ignite failed: ${e}`)
        }
    })
})

// サバイバルのときだけ道具を消費する(判定に失敗したら消費しない)
function consumeItem(player, itemId) {
    let creative = true
    try {
        creative = world.getPlayers({ name: player.name, gameMode: "creative" }).length > 0
        if (!creative) creative = world.getPlayers({ name: player.name, gameMode: "spectator" }).length > 0
    } catch (e) { creative = true }
    if (creative) return

    const container = player.getComponent("minecraft:inventory").container
    const slot = player.selectedSlotIndex ?? player.selectedSlot
    const item = container.getItem(slot)
    if (!item || item.typeId !== itemId) return

    if (itemId === "minecraft:flint_and_steel") {
        const durability = item.getComponent("minecraft:durability")
        if (durability) {
            if (durability.damage + 1 >= durability.maxDurability) {
                container.setItem(slot, undefined)
                player.dimension.playSound("random.break", player.location)
            } else {
                durability.damage += 1
                container.setItem(slot, item)
            }
        }
    } else {
        if (item.amount <= 1) container.setItem(slot, undefined)
        else { item.amount -= 1; container.setItem(slot, item) }
    }
}

// ---- レッドストーン着火: 信号が来た側の反対方向へ掘る ----
system.beforeEvents.startup.subscribe((init) => {
    init.blockComponentRegistry.registerCustomComponent("sb:redstone_ignite", {
        onTick(event) {
            try {
                const block = event.block
                if (!block || !isBreaker(block.typeId)) return
                const neighbors = [
                    ["Up", block.above()], ["Down", block.below()], ["East", block.east()],
                    ["North", block.north()], ["South", block.south()], ["West", block.west()]
                ]
                let face
                for (const [f, n] of neighbors) {
                    try {
                        const p = n.getRedstonePower()
                        if (p !== undefined && p > 0) { face = f; break }
                    } catch (e) { }
                }
                if (!face) return

                const dimension = block.dimension
                const loc = block.location
                const typeId = block.typeId
                const dir = DIG_DIRECTION[face]
                system.run(() => {
                    try {
                        if (dimension.getBlock(loc)?.typeId === typeId) ignite(dimension, loc, typeId, dir)
                    } catch (e) { }
                })
            } catch (e) { }
        }
    })
})

// ---- 導火線が切れたらトンネルを掘る(エンティティJSONのタイマーイベント) ----
world.afterEvents.dataDrivenEntityTrigger.subscribe((event) => {
    if (event.eventId !== "sb:dig") return
    const entity = event.entity
    if (!entity || entity.typeId !== BREAKER_ID) return

    let origin = { x: Math.floor(entity.location.x), y: Math.floor(entity.location.y), z: Math.floor(entity.location.z) }
    let dir = { x: 0, y: 0, z: -1 }
    let length = DEFAULT_LENGTH
    for (const tag of entity.getTags()) {
        const t = tag.split(":")
        if (t[0] === "sb_o") origin = { x: Number(t[1]), y: Number(t[2]), z: Number(t[3]) }
        else if (t[0] === "sb_d") dir = { x: Number(t[1]), y: Number(t[2]), z: Number(t[3]) }
        else if (t[0] === "sb_l") length = Number(t[1])
    }
    const dimension = entity.dimension
    dimension.playSound("random.explode", entity.location, { volume: 4 })
    startTunnel(dimension, origin, dir, length)
})

// ---- トンネル掘り(3×3の断面を奥行き方向へ) ----
function startTunnel(dimension, o, d, length) {
    // 掘る方向に垂直な2軸
    let a, b
    if (d.x !== 0) { a = { x: 0, y: 1, z: 0 }; b = { x: 0, y: 0, z: 1 } }
    else if (d.y !== 0) { a = { x: 1, y: 0, z: 0 }; b = { x: 0, y: 0, z: 1 } }
    else { a = { x: 1, y: 0, z: 0 }; b = { x: 0, y: 1, z: 0 } }

    let yMin = -64, yMax = 320
    try { yMin = dimension.heightRange.min; yMax = dimension.heightRange.max } catch (e) { }

    const bounds = (s1, s2) => {
        const p1 = { x: o.x + d.x * s1, y: o.y + d.y * s1, z: o.z + d.z * s1 }
        const p2 = { x: o.x + d.x * s2, y: o.y + d.y * s2, z: o.z + d.z * s2 }
        return {
            min: {
                x: Math.min(p1.x, p2.x) - a.x - b.x,
                y: Math.max(Math.min(p1.y, p2.y) - a.y - b.y, yMin),
                z: Math.min(p1.z, p2.z) - a.z - b.z
            },
            max: {
                x: Math.max(p1.x, p2.x) + a.x + b.x,
                y: Math.min(Math.max(p1.y, p2.y) + a.y + b.y, yMax - 1),
                z: Math.max(p1.z, p2.z) + a.z + b.z
            }
        }
    }

    const dig = (s1, s2) => {
        const { min, max } = bounds(s1, s2)
        if (min.y > max.y) return
        if (DROP_ITEMS) {
            for (let x = min.x; x <= max.x; x++)
                for (let y = min.y; y <= max.y; y++)
                    for (let z = min.z; z <= max.z; z++) {
                        try {
                            const blk = dimension.getBlock({ x, y, z })
                            if (blk && BREAKABLE_BLOCKS.includes(blk.typeId))
                                dimension.runCommand(`setblock ${x} ${y} ${z} air destroy`)
                        } catch (e) { }
                    }
            return
        }
        for (const id of BREAKABLE_BLOCKS) {
            try {
                dimension.runCommand(`fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} air replace ${id}`)
            } catch (e) { }
        }
    }

    // 遠くのチャンクも読み込まれるようにする
    const whole = bounds(1, length)
    const areaName = `sb_tunnel_${Date.now()}`
    let hasArea = false
    try {
        dimension.runCommand(`tickingarea add ${whole.min.x} ${whole.min.y} ${whole.min.z} ${whole.max.x} ${whole.max.y} ${whole.max.z} ${areaName}`)
        hasArea = true
    } catch (e) { }

    system.runTimeout(() => {
        let step = 1
        const id = system.runInterval(() => {
            try {
                const end = Math.min(step + SLICES_PER_TICK - 1, length)
                dig(step, end)
                const mid = Math.floor((step + end) / 2)
                dimension.spawnParticle("minecraft:huge_explosion_emitter", {
                    x: o.x + 0.5 + d.x * mid, y: o.y + 0.5 + d.y * mid, z: o.z + 0.5 + d.z * mid
                })
                step = end + 1
            } catch (e) {
                step = length + 1
            }
            if (step > length) {
                system.clearRun(id)
                if (hasArea) { try { dimension.runCommand(`tickingarea remove ${areaName}`) } catch (e) { } }
            }
        }, 1)
    }, hasArea ? 20 : 1)
}
