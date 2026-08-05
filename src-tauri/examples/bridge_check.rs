//! Exercise the Tasks bridge against the installed MCP server.
//!
//! Not a unit test: it needs int-tasks-mcp on the machine and writes to the
//! real store, so it is a thing you run deliberately rather than in CI.
fn main() {
    println!("tasks available: {}", int_mind_map_lib::tasks_bridge::tasks_available());

    let created = int_mind_map_lib::tasks_bridge::create_task_from_node(
        "Bridge check from the map".into(),
        "mindmap:bridge-check#node_42".into(),
    );
    match created {
        Ok(task) => {
            println!("created: {} ({})", task.title, task.id);
            match int_mind_map_lib::tasks_bridge::linked_task(task.id.clone()) {
                Ok(Some(found)) => println!("read back: {} done={}", found.title, found.done),
                Ok(None) => println!("read back: gone"),
                Err(err) => println!("read back failed: {err}"),
            }
            println!("CLEANUP_ID={}", task.id);
        }
        Err(err) => println!("create failed: {err}"),
    }

    match int_mind_map_lib::tasks_bridge::linked_task("task_does_not_exist".into()) {
        Ok(None) => println!("missing task reports as a stale link, not an error"),
        other => println!("unexpected: {other:?}"),
    }
}
