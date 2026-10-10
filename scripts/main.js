import {
    world,
    system,
    EquipmentSlot,
    EntityComponentTypes,
	EntitySwingSource,
    ItemComponentTypes,
    EnchantmentTypes
} from "@minecraft/server";

/*
 * 最初にプレイヤーが壊した1個を含めた最大数。
 *
 * 1個：通常の採掘
 * 31個：Script APIによる追加破壊
 */
const MAX_TOTAL_BREAK_COUNT = 32;

/*
 * 高い木でも一括伐採できるように、
 * 斧による一括破壊の探索距離（最大破壊数）は他ツールの6倍にする。
 */
const AXE_BREAK_RANGE_MULTIPLIER = 6;

/*
 * 1回の被ダメージで獲得できる体力上限ポイント。
 * プレイヤーの累計スコアには上限を設けない。
 */
const MAX_HEALTH_POINTS_PER_HIT = 20;

/*
 * 隣接判定に使う26方向。
 *
 * 3×3×3の中心以外をすべて登録するため、
 * 上下左右だけでなく、斜めや角で接している
 * 同種ブロックも一括破壊の対象になる。
 */
const DIRECTIONS = [];

for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
            // 中心自身は除外
            if (x === 0 && y === 0 && z === 0) {
                continue;
            }

            DIRECTIONS.push({ x, y, z });
        }
    }
}

/*
 * 一括採掘に使用できるピッケル。
 */
const PICKAXES = new Set([
    "minecraft:wooden_pickaxe",
    "minecraft:stone_pickaxe",
    "minecraft:copper_pickaxe",
    "minecraft:iron_pickaxe",
    "minecraft:golden_pickaxe",
    "minecraft:diamond_pickaxe",
    "minecraft:netherite_pickaxe"
]);

/*
 * 一括伐採に使用できる斧。
 */
const AXES = new Set([
    "minecraft:wooden_axe",
    "minecraft:stone_axe",
    "minecraft:copper_axe",
    "minecraft:iron_axe",
    "minecraft:golden_axe",
    "minecraft:diamond_axe",
    "minecraft:netherite_axe"
]);

/*
 * 採掘能力を個別に成長させる対象ツール。
 */
const HOES = new Set([
    "minecraft:wooden_hoe",
    "minecraft:stone_hoe",
    "minecraft:copper_hoe",
    "minecraft:iron_hoe",
    "minecraft:golden_hoe",
    "minecraft:diamond_hoe",
    "minecraft:netherite_hoe"
]);

const SHOVELS = new Set([
    "minecraft:wooden_shovel",
    "minecraft:stone_shovel",
    "minecraft:copper_shovel",
    "minecraft:iron_shovel",
    "minecraft:golden_shovel",
    "minecraft:diamond_shovel",
    "minecraft:netherite_shovel"
]);

const HOE_BLOCKS = new Set([
    "minecraft:hay_block",
    "minecraft:leaves",
    "minecraft:leaves2",
    "minecraft:oak_leaves",
    "minecraft:spruce_leaves",
    "minecraft:birch_leaves",
    "minecraft:jungle_leaves",
    "minecraft:acacia_leaves",
    "minecraft:dark_oak_leaves",
    "minecraft:azalea_leaves",
    "minecraft:azalea_leaves_flowered",
    "minecraft:mangrove_leaves",
    "minecraft:cherry_leaves",
    "minecraft:pale_oak_leaves",
    "minecraft:leaf_litter",
    "minecraft:wildflowers"
]);

const MINING_TOOL_STATS = [
    {
        items: PICKAXES,
        objective: "p_mineing",
        displayName: "つるはし採掘能力値",
        tagPrefix: "p_eff"
    },
    {
        items: HOES,
        objective: "h_mineing",
        displayName: "くわ採掘能力値",
        tagPrefix: "h_eff"
    },
    {
        items: AXES,
        objective: "a_mineing",
        displayName: "おの採掘能力値",
        tagPrefix: "a_eff"
    },
    {
        items: SHOVELS,
        objective: "s_mineing",
        displayName: "シャベル採掘能力値",
        tagPrefix: "s_eff"
    }
];

function getOrCreateObjective(id, displayName) {
    return world.scoreboard.getObjective(id) ??
        world.scoreboard.addObjective(id, displayName);
}

/*
 * entities/player.json の攻撃力レベルと同じ境界値。
 * minecraft:attack はコンポーネントグループが付与されるまで取得できないため、
 * 未付与の間は筋力スコアから表示用の攻撃力を求める。
 */
function getAttackDamageFromStrength(strength) {
    if (strength >= 22001) return 10;
    if (strength >= 18001) return 9;
    if (strength >= 14001) return 8;
    if (strength >= 11001) return 7;
    if (strength >= 8001) return 6;
    if (strength >= 5501) return 5;
    if (strength >= 3501) return 4;
    if (strength >= 2001) return 3;
    if (strength >= 1001) return 2;
    return 1;
}

/*
 * 一括採掘の対象となる鉱石。
 */
const ORES = new Set([
    "minecraft:coal_ore",
    "minecraft:deepslate_coal_ore",

    "minecraft:iron_ore",
    "minecraft:deepslate_iron_ore",

    "minecraft:copper_ore",
    "minecraft:deepslate_copper_ore",

    "minecraft:gold_ore",
    "minecraft:deepslate_gold_ore",
    "minecraft:nether_gold_ore",

    "minecraft:redstone_ore",
    "minecraft:lit_redstone_ore",
    "minecraft:deepslate_redstone_ore",
    "minecraft:lit_deepslate_redstone_ore",

    "minecraft:lapis_ore",
    "minecraft:deepslate_lapis_ore",

    "minecraft:diamond_ore",
    "minecraft:deepslate_diamond_ore",

    "minecraft:emerald_ore",
    "minecraft:deepslate_emerald_ore",

    "minecraft:nether_quartz_ore",

    "minecraft:ancient_debris",
	
	"minecraft:cobblestone"
]);

/*
 * TNTで破壊しない鉱石。
 *
 * ORESには一括採掘の都合で丸石も含まれているため、
 * TNT用には実際の鉱石だけを別に定義する。
 */
const TNT_PROTECTED_ORES = new Set([
    "minecraft:coal_ore",
    "minecraft:deepslate_coal_ore",
    "minecraft:iron_ore",
    "minecraft:deepslate_iron_ore",
    "minecraft:copper_ore",
    "minecraft:deepslate_copper_ore",
    "minecraft:gold_ore",
    "minecraft:deepslate_gold_ore",
    "minecraft:nether_gold_ore",
    "minecraft:redstone_ore",
    "minecraft:lit_redstone_ore",
    "minecraft:deepslate_redstone_ore",
    "minecraft:lit_deepslate_redstone_ore",
    "minecraft:lapis_ore",
    "minecraft:deepslate_lapis_ore",
    "minecraft:diamond_ore",
    "minecraft:deepslate_diamond_ore",
    "minecraft:emerald_ore",
    "minecraft:deepslate_emerald_ore",
    "minecraft:nether_quartz_ore",
    "minecraft:ancient_debris"
]);

const TNT_FUSE_TICKS = 80;
const TNT_BREAK_SIZE = 8;
const TNT_BREAKS_PER_TICK = 100;

/*
 * バニラの爆発はentities/tnt.jsonから削除し、点火されたTNTを
 * 4秒後にスクリプトで処理する。エンティティへの爆発ダメージや
 * 炎は発生させず、中心を含む8×8×8だけを対象にする。
 */
world.afterEvents.entitySpawn.subscribe((event) => {
    if (event.entity.typeId !== "minecraft:tnt") {
        return;
    }

    const tnt = event.entity;

    system.runTimeout(() => {
        if (!tnt.isValid) {
            return;
        }

        const dimension = tnt.dimension;
        const center = {
            x: Math.floor(tnt.location.x),
            y: Math.floor(tnt.location.y),
            z: Math.floor(tnt.location.z)
        };

        try {
            dimension.playSound("random.explode", tnt.location);
            dimension.spawnParticle(
                "minecraft:huge_explosion_emitter",
                tnt.location
            );
        } catch {
            // 演出に失敗してもブロック破壊は続行する。
        }

        tnt.remove();
        breakTntCube(dimension, center);
    }, TNT_FUSE_TICKS);
});

/*
 * TNTの中心から各軸-4～+3の立方体を調べる。
 * 512個を一度に処理してウォッチドッグを作動させないよう、
 * 破壊処理は複数tickに分割する。
 */
function breakTntCube(dimension, center) {
    const targets = [];
    const minOffset = -Math.floor(TNT_BREAK_SIZE / 2);
    const maxOffset = minOffset + TNT_BREAK_SIZE;

    for (let x = minOffset; x < maxOffset; x++) {
        for (let y = minOffset; y < maxOffset; y++) {
            for (let z = minOffset; z < maxOffset; z++) {
                const location = {
                    x: center.x + x,
                    y: center.y + y,
                    z: center.z + z
                };

                let block;

                try {
                    block = dimension.getBlock(location);
                } catch {
                    continue;
                }

                if (
                    !block ||
                    block.typeId === "minecraft:air" ||
                    TNT_PROTECTED_ORES.has(block.typeId)
                ) {
                    continue;
                }

                targets.push({
                    location,
                    typeId: block.typeId
                });
            }
        }
    }

    breakTntTargets(dimension, targets, 0);
}

function breakTntTargets(dimension, targets, startIndex) {
    const endIndex = Math.min(
        startIndex + TNT_BREAKS_PER_TICK,
        targets.length
    );

    for (let index = startIndex; index < endIndex; index++) {
        const target = targets[index];
        let block;

        try {
            block = dimension.getBlock(target.location);
        } catch {
            continue;
        }

        // 待機中に置き換わったブロックは壊さない。
        if (!block || block.typeId !== target.typeId) {
            continue;
        }

        try {
            const { x, y, z } = target.location;

            // 空気へ直接置き換え、破壊したブロックをドロップさせない。
            dimension.runCommand(`setblock ${x} ${y} ${z} air`);
        } catch (error) {
            console.warn(
                `TNTのブロック破壊に失敗しました: ${error}`
            );
        }
    }

    if (endIndex < targets.length) {
        system.run(() => {
            breakTntTargets(dimension, targets, endIndex);
        });
    }
}

/*
 * 一括伐採の対象となる原木・幹。
 *
 * stripped系も対象にしたい場合は、
 * 下に追加可能。
 */
const LOGS = new Set([
    "minecraft:oak_log",
    "minecraft:spruce_log",
    "minecraft:birch_log",
    "minecraft:jungle_log",
    "minecraft:acacia_log",
    "minecraft:dark_oak_log",
    "minecraft:mangrove_log",
    "minecraft:cherry_log",
    "minecraft:pale_oak_log",

    "minecraft:crimson_stem",
    "minecraft:warped_stem",
	
	"minecraft:oak_planks",
	"minecraft:oak_stairs"
]);

/*
 * プレイヤーがブロックを壊した直後に呼ばれる。
 */
world.afterEvents.playerBreakBlock.subscribe((event) => {
    const player = event.player;
    const dimension = event.dimension;

    /*
     * しゃがんでいない場合は何もしない。
     *
     * 通常時：
     *   普通に1ブロックだけ破壊
     *
     * しゃがみ中：
     *   条件を満たせば一括破壊
     */
    if (!player.isSneaking) {
        return;
    }

    /*
     * 最初のブロックを壊す直前に使用していた道具。
     */
    const usedTool = event.itemStackBeforeBreak;

    // 素手だった場合
    if (!usedTool) {
        return;
    }

    /*
     * 壊されたブロックの元の種類。
     *
     * イベント発生時にはブロックが空気になっているため、
     * brokenBlockPermutationから破壊前の種類を取得する。
     */
    const brokenTypeId =
        event.brokenBlockPermutation.type.id;

    /*
     * 鉱石・原木・鍬の対象ブロックかを判定。
     */
    const ore = isOre(brokenTypeId);
    const log = isLog(brokenTypeId);
    const hoeBlock = HOE_BLOCKS.has(brokenTypeId);

    /*
     * 一括破壊の対象外なら通常破壊だけ。
     */
    if (!ore && !log && !hoeBlock) {
        return;
    }

    /*
     * 鉱石はピッケルで壊した場合だけ一括破壊。
     */
    if (ore && !PICKAXES.has(usedTool.typeId)) {
        return;
    }

    /*
     * 原木は斧で壊した場合だけ一括破壊。
     */
    if (log && !AXES.has(usedTool.typeId)) {
        return;
    }

    /*
     * 最初に壊したブロックの座標。
     */
    if (hoeBlock && !HOES.has(usedTool.typeId)) {
        return;
    }

    const startLocation = {
        x: event.block.location.x,
        y: event.block.location.y,
        z: event.block.location.z
    };

    /*
     * ブロック変更や装備変更を安全に行うため、
     * 次のtickへ処理を回す。
     */
    system.run(() => {
        veinMine(
            player,
            dimension,
            startLocation,
            brokenTypeId
        );
    });
});

/*
 * 同じ種類のブロックを探索して一括破壊する。
 */
function veinMine(
    player,
    dimension,
    startLocation,
    brokenTypeId
) {
    /*
     * プレイヤーの装備コンポーネント。
     */
    const equippable = player.getComponent(
        EntityComponentTypes.Equippable
    );

    if (!equippable) {
        return;
    }

    /*
     * ブロックのルートテーブルから、
     * 使用道具に応じたドロップを生成する管理機能。
     *
     * @minecraft/server 2.2.0以上が必要。
     */
    const lootManager = world.getLootTableManager();

    /*
     * これから周囲を調べる座標。
     */
    const queue = [startLocation];

    /*
     * queue.shift()を使わず、
     * インデックスを進めて読み取る。
     */
    let queueIndex = 0;

    /*
     * すでに確認した座標。
     *
     * 同じ位置を繰り返し調べて
     * 無限ループすることを防ぐ。
     */
    const checked = new Set([
        positionKey(startLocation)
    ]);

    /*
     * 実際に追加破壊するブロック。
     */
    const targets = [];

    /*
     * 最初の1個はプレイヤーがすでに壊している。
     *
     * 斧で伐採する原木は、他ツールの6倍まで探索・破壊する。
     * 通常は合計32個（追加31個）、原木は合計192個（追加191個）。
     */
    const maxTotalBreakCount = isLog(brokenTypeId)
        ? MAX_TOTAL_BREAK_COUNT * AXE_BREAK_RANGE_MULTIPLIER
        : MAX_TOTAL_BREAK_COUNT;
    const maxAdditionalCount = maxTotalBreakCount - 1;

    /*
     * 幅優先探索。
     */
    while (
        queueIndex < queue.length &&
        targets.length < maxAdditionalCount
    ) {
        const current = queue[queueIndex];
        queueIndex++;

        /*
         * 現在位置から26方向を調べる。
         */
        for (const direction of DIRECTIONS) {
            if (
                targets.length >=
                maxAdditionalCount
            ) {
                break;
            }

            const location = {
                x: current.x + direction.x,
                y: current.y + direction.y,
                z: current.z + direction.z
            };

            const key = positionKey(location);

            /*
             * すでに調べた場所は飛ばす。
             */
            if (checked.has(key)) {
                continue;
            }

            checked.add(key);

            let block;

            try {
                block = dimension.getBlock(location);
            } catch {
                continue;
            }

            /*
             * 範囲外や未読み込みチャンクなど。
             */
            if (!block) {
                continue;
            }

            /*
             * 最初に壊したブロックと同じ種類だけ対象。
             *
             * 例：
             * 通常のダイヤ鉱石と深層ダイヤ鉱石は
             * 別のブロックとして扱われる。
             */
            if (block.typeId !== brokenTypeId) {
                continue;
            }

            targets.push(location);
            queue.push(location);
        }
    }

    let additionalBrokenCount = 0;

    /*
     * 探索で見つかったブロックを順番に破壊する。
     */
    for (const location of targets) {
        /*
         * 毎回現在のメインハンドを取得する。
         *
         * 途中で道具が壊れたり、
         * プレイヤーが持ち替えた場合に対応する。
         */
        const tool = equippable.getEquipment(
            EquipmentSlot.Mainhand
        );

        if (!tool) {
            break;
        }

        /*
         * 鉱石なら現在もピッケルを持っている必要がある。
         */
        if (
            isOre(brokenTypeId) &&
            !PICKAXES.has(tool.typeId)
        ) {
            break;
        }

        /*
         * 原木なら現在も斧を持っている必要がある。
         */
        if (
            isLog(brokenTypeId) &&
            !AXES.has(tool.typeId)
        ) {
            break;
        }

        if (HOE_BLOCKS.has(brokenTypeId) && !HOES.has(tool.typeId)) {
            break;
        }

        let block;

        try {
            block = dimension.getBlock(location);
        } catch {
            continue;
        }

        if (!block) {
            continue;
        }

        /*
         * 探索後に別の原因でブロックが変わっていた場合は、
         * その場所を破壊しない。
         */
        if (block.typeId !== brokenTypeId) {
            continue;
        }

        let drops;

        try {
            /*
             * 実際に持っている道具を渡す。
             *
             * 道具に付いている幸運・シルクタッチなどを
             * 考慮したドロップが生成される。
             */
            drops = lootManager.generateLootFromBlock(
                block,
                tool
            );
        } catch (error) {
            console.warn(
                `一括破壊のドロップ生成に失敗しました: ${error}`
            );

            continue;
        }

        /*
         * この道具では適切なドロップを生成できない場合。
         */
        if (drops === undefined) {
            continue;
        }

        const dropLocation = {
            x: location.x + 0.5,
            y: location.y + 0.5,
            z: location.z + 0.5
        };

        try {
            /*
             * ドロップを二重発生させないため、
             * 通常破壊コマンドではなく空気へ直接変更する。
             */
            block.setType("minecraft:air");
            additionalBrokenCount++;

            // 直接空気に変更したブロックは採掘イベントが発生しない。
            // 実際に破壊できた1個分を、使用した道具のポイントへ加算する。
            addMiningPoint(player, tool);

            /*
             * LootTableManagerで生成したドロップを出現させる。
             */
            for (const itemStack of drops) {
                dimension.spawnItem(
                    itemStack,
                    dropLocation
                );
            }
        } catch (error) {
            console.warn(
                `一括破壊のブロック変更に失敗しました: ${error}`
            );

            continue;
        }

        /*
         * 追加で壊した1ブロック分だけ道具を消耗させる。
         *
         * 最初にプレイヤーが壊した1個分は、
         * マイクラ本体がすでに耐久値を処理している。
         */
        const toolBroken = damageTool(
            equippable,
            tool
        );

        /*
         * 道具が壊れたら一括破壊を終了する。
         */
        if (toolBroken) {
            try {
                player.playSound("random.break");
            } catch {
                // サウンド再生失敗は無視
            }

            break;
        }
    }

    /*
     * 追加破壊が発生した場合だけメッセージを表示する。
     */
    if (additionalBrokenCount > 0) {
        player.sendMessage(
            `§a一括破壊：合計${
                additionalBrokenCount + 1
            }個`
        );
    }
}

/*
 * 道具の耐久値を1ブロック分処理する。
 *
 * 戻り値：
 * true  = 道具が壊れた
 * false = 道具が壊れていない
 */
function damageTool(
    equippable,
    tool
) {
    /*
     * 耐久値コンポーネントを取得する。
     */
    const durability = tool.getComponent(
        ItemComponentTypes.Durability
    );

    /*
     * 耐久値を持たないアイテム。
     */
    if (!durability) {
        return false;
    }

    /*
     * 耐久力エンチャントを取得する。
     */
    const enchantable = tool.getComponent(
        ItemComponentTypes.Enchantable
    );

    const unbreakingLevel =
        enchantable
            ?.getEnchantment("unbreaking")
            ?.level ?? 0;

    /*
     * 耐久値が実際に減る確率を取得する。
     *
     * 戻り値は0～100の百分率。
     */
    const damageChance =
        durability.getDamageChance(
            unbreakingLevel
        );

    /*
     * 耐久力エンチャントの効果で、
     * 今回は耐久値が減らなかった場合。
     */
    if (
        Math.random() * 100 >=
        damageChance
    ) {
        return false;
    }

    /*
     * 次の耐久損傷値。
     *
     * durability.damageは、
     * 残り耐久値ではなく使用済み耐久値。
     */
    const nextDamage =
        durability.damage + 1;

    /*
     * 最大耐久値へ到達したら道具を壊す。
     */
    if (
        nextDamage >=
        durability.maxDurability
    ) {
        equippable.setEquipment(
            EquipmentSlot.Mainhand,
            undefined
        );

        return true;
    }

    /*
     * 耐久損傷値を更新する。
     */
    durability.damage = nextDamage;

    /*
     * 変更したItemStackを実際のメインハンドへ書き戻す。
     */
    equippable.setEquipment(
        EquipmentSlot.Mainhand,
        tool
    );

    return false;
}

/*
 * 鉱石かどうか。
 */
function isOre(typeId) {
    return ORES.has(typeId);
}

/*
 * 原木かどうか。
 */
function isLog(typeId) {
    return LOGS.has(typeId);
}

/*
 * 座標をSetへ保存できる文字列へ変換する。
 *
 * 例：
 * { x: 10, y: 64, z: -5 }
 *
 * ↓
 *
 * "10,64,-5"
 */
function positionKey(location) {
    return (
        `${location.x},` +
        `${location.y},` +
        `${location.z}`
    );
}

world.afterEvents.playerSwingStart.subscribe((event) => {
    const player = event.player;

    // 攻撃操作による腕振りだけに限定
    if (event.swingSource !== EntitySwingSource.Attack) return;

});

world.afterEvents.entityHurt.subscribe((event) => {
    const player = event.hurtEntity;

    /*
     * 攻撃を当てた回数ではなく、実際に減らした体力に応じて
     * 攻撃したプレイヤーの筋力を成長させる。
     *
     * Minecraftの体力値1（ハート半分）につき筋力1とし、
     * 小数部分はスコアへ保存できないため切り捨てる。
     * 1回の攻撃で得られる筋力は、ダメージ量にかかわらず最大10とする。
     */
    const attacker = event.damageSource.damagingEntity;

    if (
        attacker?.typeId === "minecraft:player" &&
        attacker.id !== player.id
    ) {
        const strengthPoints = Math.min(Math.floor(event.damage), 10);
        const identity = attacker.scoreboardIdentity;

        if (strengthPoints > 0 && identity) {
            const strengthObjective = getOrCreateObjective(
                "strength",
                "筋力"
            );
            const currentStrength =
                strengthObjective.getScore(identity) ?? 0;

            strengthObjective.setScore(
                identity,
                currentStrength + strengthPoints
            );
        }
    }

    /*
     * 1ハート（2ダメージ）減るごとに1ポイントを付与し、
     * 半端なハートは切り捨てる。
     * 1回に獲得できるポイントだけを最大20に制限し、累計には加算し続ける。
     */
    if (player.typeId !== "minecraft:player") return;

    const points = Math.min(
        Math.floor(event.damage / 2),
        MAX_HEALTH_POINTS_PER_HIT
    );
    if (points < 1) return;

    let healthMaxObjective = world.scoreboard.getObjective("health_max");
    if (!healthMaxObjective) {
        healthMaxObjective = world.scoreboard.addObjective(
            "health_max",
            "体力上限"
        );
    }

    const identity = player.scoreboardIdentity;
    if (!identity) return;

    const currentScore = healthMaxObjective.getScore(identity) ?? 0;
    healthMaxObjective.setScore(identity, currentScore + points);
});

world.afterEvents.playerBreakBlock.subscribe((event) => {
    addMiningPoint(event.player, event.itemStackBeforeBreak);
});

/*
 * 通常採掘・一括採掘共通で、破壊した1ブロック分のポイントを加算する。
 */
function addMiningPoint(player, usedTool) {
    if (!usedTool) return;

    const toolStat = MINING_TOOL_STATS.find(({ items }) =>
        items.has(usedTool.typeId)
    );

    if (!toolStat) return;

    const objective = getOrCreateObjective(
        toolStat.objective,
        toolStat.displayName
    );
    const identity = player.scoreboardIdentity;

    if (!objective || !identity) return;

    const currentScore = objective.getScore(identity) ?? 0;
    objective.setScore(identity, currentScore + 1);
}

/*
 * 各ツール用の効率強化タグから、手に持っている対応ツールへ
 * 付与すべき効率強化レベルを求める。
 */
function getEfficiencyLevel(player, tagPrefix) {
    for (let index = 4; index >= 0; index--) {
        if (player.hasTag(`${tagPrefix}${index}`)) {
            return index + 1;
        }
    }

    return 0;
}

function applyToolEfficiency(player) {
    const equippable = player.getComponent(
        EntityComponentTypes.Equippable
    );

    if (!equippable) return;

    const tool = equippable.getEquipment(EquipmentSlot.Mainhand);

    if (!tool) return;

    const toolStat = MINING_TOOL_STATS.find(({ items }) =>
        items.has(tool.typeId)
    );

    if (!toolStat) return;

    const level = getEfficiencyLevel(player, toolStat.tagPrefix);

    if (level === 0) return;

    const enchantable = tool.getComponent(ItemComponentTypes.Enchantable);
    const efficiencyType = EnchantmentTypes.get("efficiency");

    if (!enchantable || !efficiencyType) return;

    const currentLevel =
        enchantable.getEnchantment(efficiencyType)?.level ?? 0;

    if (currentLevel >= level) return;

    enchantable.addEnchantment({
        type: efficiencyType,
        level
    });

    equippable.setEquipment(EquipmentSlot.Mainhand, tool);
}

system.runInterval(() => {
    const scoreboard = world.scoreboard;

    const strengthObjective =
        scoreboard.getObjective("strength");

    const pickaxeMiningObjective = getOrCreateObjective(
        "p_mineing",
        "つるはし採掘能力値"
    );
    const hoeMiningObjective = getOrCreateObjective(
        "h_mineing",
        "くわ採掘能力値"
    );
    const axeMiningObjective = getOrCreateObjective(
        "a_mineing",
        "おの採掘能力値"
    );
    const shovelMiningObjective = getOrCreateObjective(
        "s_mineing",
        "シャベル採掘能力値"
    );

    const healthMaxObjective =
        scoreboard.getObjective("health_max");

    for (const player of world.getAllPlayers()) {

        const hunger = player.getComponent(
            EntityComponentTypes.Hunger
        );

        const saturation = player.getComponent(
            EntityComponentTypes.Saturation
        );

        const exhaustion = player.getComponent(
            EntityComponentTypes.Exhaustion
        );

        const attack = player.getComponent(
            "minecraft:attack"
        );

        // minecraft:attack は動的なコンポーネントなので、未付与でも表示を止めない。
        if (!hunger || !saturation || !exhaustion) {
            continue;
        }

        /*
         * スコアボード値取得
         */
        const strength =
            strengthObjective?.getScore(
                player.scoreboardIdentity
            ) ?? 0;

        const pickaxeMining =
            pickaxeMiningObjective?.getScore(player.scoreboardIdentity) ?? 0;
        const hoeMining =
            hoeMiningObjective?.getScore(player.scoreboardIdentity) ?? 0;
        const axeMining =
            axeMiningObjective?.getScore(player.scoreboardIdentity) ?? 0;
        const shovelMining =
            shovelMiningObjective?.getScore(player.scoreboardIdentity) ?? 0;

        const healthMax =
            healthMaxObjective?.getScore(
                player.scoreboardIdentity
            ) ?? 0;

        const attackDamage =
            attack?.currentValue ?? getAttackDamageFromStrength(strength);

        /*
         * アクションバー表示
         */
        applyToolEfficiency(player);

        player.onScreenDisplay.setActionBar(
            `§c筋力: §f${strength}  ` +
            `§4現在の攻撃力: §f${attackDamage.toFixed(0)}  ` +
            `§b採掘能力: §fP:${pickaxeMining} H:${hoeMining} ` +
            `A:${axeMining} S:${shovelMining}  ` +
            `§a体力上限: §f${healthMax}  ` +
            `§6満腹度: §f${hunger.currentValue.toFixed(0)}  ` +
            `§e隠し満腹度: §f${saturation.currentValue.toFixed(1)}  `
        );
    }
}, 5);


// 紐（トリップワイヤー）に触れているMobに鈍足Iを付与する。
// 離れた後は1秒で切れるよう、5ティックごとに更新する。
system.runInterval(() => {
    for (const dimensionId of ["overworld", "nether", "the_end"]) {
        const dimension = world.getDimension(dimensionId);
        for (const entity of dimension.getEntities()) {
            try {
                if (entity.typeId === "minecraft:player" ||
                    !entity.getComponent(EntityComponentTypes.Health)) continue;

                const location = entity.location;
                const block = dimension.getBlock({
                    x: Math.floor(location.x),
                    y: Math.floor(location.y),
                    z: Math.floor(location.z)
                });
                if (block?.typeId === "minecraft:tripwire") {
                    entity.addEffect("slowness", 20, { amplifier: 0 });
                }
            } catch {
                // デスポーンや未ロードのチャンクは次回の判定に任せる。
            }
        }
    }
}, 5);


// 15ブロック以内の鉱物ドロップを最も近いプレイヤーへ移動する。
const MAGNET_ITEM_TYPES = new Set([
    "minecraft:coal",
    "minecraft:raw_iron",
    "minecraft:raw_copper",
    "minecraft:raw_gold",
    "minecraft:diamond"
]);
const MAGNET_RADIUS = 15;

system.runInterval(() => {
    const candidates = new Map();
    for (const player of world.getAllPlayers()) {
        const location = player.location;
        for (const item of player.dimension.getEntities({
            type: "minecraft:item",
            location,
            maxDistance: MAGNET_RADIUS
        })) {
            try {
                const stack = item.getComponent(EntityComponentTypes.Item)?.itemStack;
                if (!stack || !MAGNET_ITEM_TYPES.has(stack.typeId)) continue;

                const itemLocation = item.location;
                const distanceSquared =
                    (itemLocation.x - location.x) ** 2 +
                    (itemLocation.y - location.y) ** 2 +
                    (itemLocation.z - location.z) ** 2;
                const current = candidates.get(item.id);
                if (!current || distanceSquared < current.distanceSquared) {
                    candidates.set(item.id, { item, player, distanceSquared });
                }
            } catch {
                // 回収済み・消滅済みのドロップは処理しない。
            }
        }
    }
    for (const { item, player } of candidates.values()) {
        try {
            item.teleport(player.location, { dimension: player.dimension });
        } catch {
            // 判定後に回収・消滅した場合は次回の判定に任せる。
        }
    }
}, 5);


// Lungeによる前方加速に、その約2倍を追加して合計約3倍にする。
const SPEAR_LUNGE_SPEED_MULTIPLIER = 3;
const SPEAR_TYPES = new Set([
    "minecraft:wooden_spear", "minecraft:stone_spear",
    "minecraft:copper_spear", "minecraft:iron_spear",
    "minecraft:golden_spear", "minecraft:diamond_spear",
    "minecraft:netherite_spear"
]);
const spearVelocitySamples = new Map();
const pendingSpearLunges = new Set();

system.runInterval(() => {
    const activeIds = new Set();
    for (const player of world.getAllPlayers()) {
        activeIds.add(player.id);
        const old = spearVelocitySamples.get(player.id);
        spearVelocitySamples.set(player.id, {
            tick: system.currentTick,
            dimensionId: player.dimension.id,
            velocity: player.getVelocity(),
            previous: old ? {
                tick: old.tick,
                dimensionId: old.dimensionId,
                velocity: old.velocity
            } : undefined
        });
    }
    for (const id of spearVelocitySamples.keys()) {
        if (!activeIds.has(id)) spearVelocitySamples.delete(id);
    }
}, 1);

world.afterEvents.playerSwingStart.subscribe((event) => {
    if (event.swingSource !== EntitySwingSource.Attack) return;
    const tool = event.heldItemStack;
    if (!tool || !SPEAR_TYPES.has(tool.typeId)) return;
    const enchantable = tool.getComponent(ItemComponentTypes.Enchantable);
    if (!enchantable?.getEnchantment("lunge")) return;

    const player = event.player;
    if (pendingSpearLunges.has(player.id)) return;
    const sample = spearVelocitySamples.get(player.id);
    const before = sample?.tick < system.currentTick ? sample : sample?.previous;
    if (!before || system.currentTick - before.tick > 2 ||
        before.dimensionId !== player.dimension.id) return;

    const view = player.getViewDirection();
    const horizontalLength = Math.hypot(view.x, view.z);
    if (horizontalLength < 0.01) return;
    const direction = { x: view.x / horizontalLength, z: view.z / horizontalLength };
    const dimensionId = player.dimension.id;
    pendingSpearLunges.add(player.id);
    system.run(() => {
        try {
            if (player.dimension.id !== dimensionId) return;
            const currentTool = player.getComponent(EntityComponentTypes.Equippable)
                ?.getEquipment(EquipmentSlot.Mainhand);
            if (currentTool?.typeId !== tool.typeId) return;
            const velocity = player.getVelocity();
            const forwardGain =
                (velocity.x - before.velocity.x) * direction.x +
                (velocity.z - before.velocity.z) * direction.z;
            // クールダウン中など、実際の前方加速がない攻撃には追加しない。
            if (forwardGain <= 0.1) return;
            const extra = forwardGain * (SPEAR_LUNGE_SPEED_MULTIPLIER - 1);
            player.applyImpulse({
                x: direction.x * extra,
                y: 0,
                z: direction.z * extra
            });
        } catch {
            // ログアウト・ディメンション移動などで無効になった場合は中止する。
        } finally {
            pendingSpearLunges.delete(player.id);
        }
    });
});
