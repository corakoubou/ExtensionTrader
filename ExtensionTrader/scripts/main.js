import {
    world,
    system,
    EquipmentSlot,
    EntityComponentTypes,
	EntitySwingSource,
    ItemComponentTypes
} from "@minecraft/server";

/*
 * 最初にプレイヤーが壊した1個を含めた最大数。
 *
 * 1個：通常の採掘
 * 31個：Script APIによる追加破壊
 */
const MAX_TOTAL_BREAK_COUNT = 32;

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
     * 鉱石か原木かを判定。
     */
    const ore = isOre(brokenTypeId);
    const log = isLog(brokenTypeId);

    /*
     * 鉱石でも原木でもない場合は通常破壊だけ。
     */
    if (!ore && !log) {
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
     * 合計32個にする場合、
     * Script APIで追加破壊するのは最大31個。
     */
    const maxAdditionalCount =
        MAX_TOTAL_BREAK_COUNT - 1;

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

        additionalBrokenCount++;

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

world.afterEvents.entityHitEntity.subscribe((event) => {

    const attacker = event.damagingEntity;
    const victim = event.hitEntity;

    // プレイヤー以外は無視
    if (attacker.typeId !== "minecraft:player") return;

    // 攻撃したプレイヤー本人にイベントを実行
    attacker.runCommand(
        "execute if score @s strength matches 0.. run scoreboard players add @s strength 2"
    );
});

world.afterEvents.playerBreakBlock.subscribe((event) => {
    const player = event.player;
    const block = event.brokenBlockPermutation;
	    // 左クリックした本人にイベントを実行
    player.runCommand("execute if score @s strength matches 0.. run scoreboard players add @s mineing 1");
});

system.runInterval(() => {
    const scoreboard = world.scoreboard;

    const strengthObjective =
        scoreboard.getObjective("strength");

    const mineingObjective =
        scoreboard.getObjective("mineing");

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

        const mineing =
            mineingObjective?.getScore(
                player.scoreboardIdentity
            ) ?? 0;

        /*
         * アクションバー表示
         */
        player.onScreenDisplay.setActionBar(
            `§c筋力: §f${strength}  ` +
            `§b採掘能力: §f${mineing}  ` +
            `§6満腹度: §f${hunger.currentValue.toFixed(0)}  ` +
            `§e隠し満腹度: §f${saturation.currentValue.toFixed(1)}  `
        );
    }
}, 5);