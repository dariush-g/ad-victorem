
## Done

1. ~~Add shields.~~ Round shield (`parma`, 280 gold), worn on the left arm.
    - Holding E with a shield raises it instead of the sword: cheaper, wider, and lets less through. Q still parries with the weapon.
    - Still to check in game: the carry and raise poses (`SHIELD_CARRY` / `SHIELD_RAISE` in `src/gladiator.ts`).

2. ~~Add other weapons like maces, spears, etc~~ Spear added (`hasta`, 450 gold).
    - Two-handed (no shield), longest reach (1.6 m), its own thrusts, parry and block.
    - Balanced: getting parried makes you reel 1.6× as long.
    - Still to check in game: the grips and thrust poses (`SPEAR_*` in `src/gladiator.ts`), and that both hands stay on the shaft.
    - Still to do: more weapons (mace, axe, dagger...).

## To do

3. Add new armor that protects you more

4. make gear have a certain weight, weapons, and armor, etc
    - the more your equipment weights, the slower you are.
    - Your swinging speed depends on your strength, so using a heavy weapon with low strength is more difficult/slower/uses more stamina

5. Redeploy the server (`server/deploy.sh`) so the shop sells the shield and spear, and `npm run deploy` the game.
